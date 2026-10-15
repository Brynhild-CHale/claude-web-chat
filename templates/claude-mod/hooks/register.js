// The web-chat mod — a Claude Code plugin of function hooks (spec §15.7, tier 2).
//
// It runs INSIDE the user's Claude Code session (2.1.287 and newer), in Claude
// Code's own runtime: no Node, no DOM, no import — everything outside this file
// is reached through `$`. It is generic: it implements every op and every event
// of web-chat's mod wire (lib/core/mod-protocol.js, whose lists and caps WIRE
// below copies — test/claude-mod.test.js holds the two equal) and nothing else,
// so what the daemon does with them is the daemon's business.
//
// WHAT IT DOES
//   1. The gate. At session.start it walks up from the session's directory to
//      the nearest `.web-chat/` (never $HOME's: that is web-chat's per-user
//      folder). None: it does nothing more for the session — no network call at
//      all. A disabled marker (the project's, the user's, or this session's):
//      it idles and looks again every 30 s. Then it reads `.web-chat/server.json`
//      for the daemon's port, and treats a record whose `root` is not its own
//      project (realpath on both sides), or one with no `root`, as "no daemon of
//      this project": it backs off and reads the file again. It never starts a
//      daemon.
//   2. The hello: after a /clear or /resume end, only once $.session.id() has
//      moved off the ended id (at most SWITCH_WAIT_MS; a turn start re-checks
//      it, detaches the old id and says hello again, below), then
//      POST /api/bridge/hello on 127.0.0.1, which answers a token the
//      mod keeps in memory only (never on disk, never in a URL, never Claude
//      Code's own messaging token, which this file never reads). 409 protocol or
//      too-old: it stops for the session; 409 disabled: it waits retry_ms; 409
//      wrong-project, or any network failure: back off 1 s, 2 s, … 60 s, reading
//      server.json again each time (a restarted daemon moves port). 401 from any
//      route: hello again.
//   3. The op loop: GET /api/bridge/ops?wait= (a long poll), each op checked
//      against WIRE again, run, and answered on POST /api/bridge/result. It is
//      started from session.start and never awaited there: $.command.run refuses
//      to run inside a hook that holds a turn. It runs as a detached loop; if
//      Claude Code refuses `$` calls made outside a hook, it falls back to
//      driving each step from $.clock.every, so every call runs inside a
//      dispatch Claude Code scheduled (ruling C-defaults (a)); the `diag` event
//      says which driver ran, for gate V35, and how many events were dropped
//      or failed to send.
//   4. The events, batched (every flush_ms, or at once at BATCH_MAX), at most
//      200 waiting (the oldest dropped and counted).
//   5. PermissionRequest transport: with the hello's permission_wait_ms > 0, a
//      prompt is forwarded and waits that long for a permissionDecision op; the
//      decision {pass: true} (ruling D5 (a)), no decision, or a wait of 0 leave
//      the prompt to the terminal (next(e)).
//
// WHAT IT NEVER DOES: alter a tool call, a model step or a row (every hook
// passes `e` on unchanged and returns exactly what next(e) returned); run a
// command outside WIRE.MOD_COMMANDS — no config-persisting command (/model,
// /config, /permissions, …) even if a forged op asks (ruling Q10); submit text
// beginning with `/` (that would run a command as the user); write a file.
// A failure in its own bookkeeping is counted and dropped, never thrown into
// Claude Code.

// Stamped by `claude-web-chat mod on` (lib/setup/registration applyMod) with
// the web-chat version that staged this copy.
const MOD_VERSION = '0.0.0-template';

// lib/core/mod-protocol's wire, as JSON. test/claude-mod.test.js parses this
// literal and holds it deep-equal to that module's exports.
const WIRE = Object.freeze({
  "MOD_PROTOCOL": 1,
  "MOD_MIN_CLAUDE": "2.1.287",
  "OPS": ["abort", "taskStop", "submit", "command", "fill", "permissionDecision", "usage", "messages"],
  "MOD_COMMANDS": ["plan", "compact", "context", "clear", "rename", "resume", "recap"],
  "EVENT_KINDS": [
    "session.start", "turn.start", "turn.step", "turn.complete", "tool.call", "tool.done",
    "session.append", "session.compact", "session.measure", "prompt.submit",
    "permission.request", "permission.settled"
  ],
  "BRIDGE_ONLY_KINDS": ["session.end", "diag"],
  "BODY_MAX": 65536,
  "BATCH_MAX": 50,
  "DELTA_MAX": 4096,
  "TEXT_MAX": 32768,
  "INPUT_MAX": 8192,
  "ARG_TEXT_MAX": 16384,
  "RENAME_MAX": 64,
  "COMMAND_ARGS_MAX": 2000,
  "OPS_WAIT_MAX_MS": 20000,
  "FLUSH_MS": 100,
  "RESULT_MAX": 8192,
  "ERROR_MAX": 200,
  "PERMISSION_WAIT_MAX_MS": 590000
});

const LOOPBACK = '127.0.0.1';
const RECHECK_MS = 30000; // a disabled project, looked at again
const BACKOFF_MAX_MS = 60000;
const PENDING_MAX = 200; // events waiting to be sent
const BATCH_BYTES = WIRE.BODY_MAX - 2048; // a POST body, with room for the envelope
const ABORT_SETTLE_MS = 2000; // how long a foreground Bash may take to settle backgrounded
const SUBMIT_WAIT_MS = 1500; // $.prompt.submit resolves when its turn starts: answer before that
const COMMAND_WAIT_MS = 8000; // the bridge's result window is 10 s
const DRIVER_CHECK_MS = 3000; // how often the session.start timer looks at the loop
const DRIVER_CHECKS = 5; // … and for how long (then a failing loop asks the next hook)
const CLOCK_TICK_MS = 250; // the fallback driver's period
// After a /clear or /resume end, Claude Code moves the process to its next
// session id only once its own work is done (2.1.300's in-app resume runs the
// SessionStart hooks first), so the id is read again every SWITCH_POLL_MS
// until it differs from the ended one, for at most SWITCH_WAIT_MS: a resume
// of the same conversation keeps its id, and says hello with it then.
const SWITCH_POLL_MS = 100;
const SWITCH_WAIT_MS = 3000;
const SWITCH_READS = Math.ceil(SWITCH_WAIT_MS / SWITCH_POLL_MS);
const SHAPE_PATHS = 48;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.+-]{1,48})?$/;
const WORD = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const SHAPE_KEY = /^[A-Za-z0-9_$.[\]-]{1,128}$/;

// Thrown through the op loop: `$` refused a call made outside a hook (the
// fallback driver takes over), or the module's environment was unloaded (the
// mod stops).
const OUTSIDE = { outside: true };
const STOP = { stop: true };

// ── small pure helpers ──────────────────────────────────────────────────────

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function messageOf(e) {
  if (e && typeof e.message === 'string') return e.message;
  try { return String(e); } catch { return 'error'; }
}

function isUnloaded(e) {
  return /environment is unloaded|no longer loaded/i.test(messageOf(e));
}

function cut(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1; } else n += 3;
  }
  return n;
}

function jsonLen(v) {
  try { const s = JSON.stringify(v); return s === undefined ? 0 : utf8Len(s); } catch { return Infinity; }
}

// A JSON copy of `v`, strings cut to `limit`, depth, keys and items bounded.
function copyCut(v, depth, limit) {
  if (typeof v === 'string') return cut(v, limit);
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'object' || depth >= 8) return undefined;
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => { const c = copyCut(x, depth + 1, limit); return c === undefined ? null : c; });
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= 64) break;
    const c = copyCut(v[k], depth + 1, limit);
    if (c === undefined) continue;
    out[cut(k, 128)] = c;
    n += 1;
  }
  return out;
}

// A plain object inside `maxBytes` of JSON: strings halve until it fits.
function bounded(v, maxBytes) {
  if (!isPlain(v)) return {};
  let limit = maxBytes;
  for (;;) {
    const c = copyCut(v, 0, limit);
    if (jsonLen(c) <= maxBytes) return c;
    if (limit <= 16) return { truncated: true };
    limit >>= 1;
  }
}

// Numbers only, nested at most three deep: what `usage` and `session.measure`
// may say.
function numbersOnly(v, depth = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (v === null || typeof v !== 'object' || depth >= 3) return undefined;
  if (Array.isArray(v)) {
    const out = v.slice(0, 16).map((x) => numbersOnly(x, depth + 1)).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= 32) break;
    if (!WORD.test(k)) continue;
    const x = numbersOnly(v[k], depth + 1);
    if (x === undefined) continue;
    out[k] = x;
    n += 1;
  }
  return Object.keys(out).length ? out : undefined;
}

function usageOf(u) {
  if (!isPlain(u)) return undefined;
  const out = {};
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0) out[k] = u[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function originOf(o) {
  if (!isPlain(o) || typeof o.kind !== 'string' || !WORD.test(o.kind)) return undefined;
  const out = { kind: o.kind };
  if (typeof o.asUser === 'boolean') out.as_user = o.asUser;
  else if (typeof o.as_user === 'boolean') out.as_user = o.as_user;
  return out;
}

function idOr(v, re = EVENT_ID) {
  return typeof v === 'string' && re.test(v) ? v : undefined;
}

// One appended row, as the wire carries it: text cut, tool_use input bounded,
// tool_result reduced to its id and error flag, every other block its type.
function rowOf(message) {
  if (!isPlain(message)) return null;
  const role = typeof message.role === 'string' && WORD.test(message.role) ? message.role
    : (typeof message.type === 'string' && WORD.test(message.type) ? message.type : null);
  if (!role) return null;
  let budget = WIRE.TEXT_MAX;
  const text = (s) => { const c = cut(typeof s === 'string' ? s : '', Math.max(0, budget)); budget -= c.length; return c; };
  const out = { role };
  const mid = idOr(message.id);
  if (mid) out.id = mid;
  if (typeof message.model === 'string' && message.model) out.model = cut(message.model, 128);
  const content = message.content;
  if (typeof content === 'string') out.content = text(content);
  else if (Array.isArray(content)) {
    out.content = [];
    for (const b of content.slice(0, 64)) {
      if (!isPlain(b) || typeof b.type !== 'string') continue;
      if (b.type === 'text') out.content.push({ type: 'text', text: text(b.text) });
      else if (b.type === 'tool_use') {
        const block = { type: 'tool_use' };
        const id = idOr(b.id);
        if (id) block.id = id;
        if (typeof b.name === 'string') block.name = cut(b.name, 200);
        block.input = bounded(b.input, WIRE.INPUT_MAX);
        out.content.push(block);
      } else if (b.type === 'tool_result') {
        const block = { type: 'tool_result' };
        const id = idOr(b.tool_use_id);
        if (id) block.tool_use_id = id;
        if (typeof b.is_error === 'boolean') block.is_error = b.is_error;
        out.content.push(block);
      } else out.content.push({ type: cut(b.type, 32) });
    }
  } else out.content = [];
  return out;
}

// The key names (never values) of a value, one level into each object key:
// what `diag` reports for gate V35's hinges H3–H5.
function keyPaths(v, prefix = '') {
  if (!isPlain(v)) return [];
  const out = [];
  for (const k of Object.keys(v)) {
    const p = `${prefix}${k}`;
    if (SHAPE_KEY.test(p)) out.push(p);
    if (!prefix && isPlain(v[k])) for (const k2 of Object.keys(v[k])) { const p2 = `${p}.${k2}`; if (SHAPE_KEY.test(p2)) out.push(p2); }
  }
  return out;
}

// Anywhere in a decision: a bypass, or a write outside the session. The
// daemon refuses these before an op is queued; the mod refuses them again.
function forbiddenDecision(v, depth = 0) {
  if (depth > 16) return true;
  if (v === 'bypassPermissions') return true;
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => forbiddenDecision(x, depth + 1));
  for (const k of Object.keys(v)) {
    if (k === 'bypassPermissions') return true;
    if (k === 'destination' && v[k] !== 'session') return true;
    if (forbiddenDecision(v[k], depth + 1)) return true;
  }
  return false;
}

// The pass-through sentinel (ruling D5 (a)): exactly {pass: true}.
function isPass(d) {
  return isPlain(d) && Object.keys(d).length === 1 && d.pass === true;
}

function versionOf(v) {
  const candidates = isPlain(v) ? [v.version, v.base] : [v];
  for (const c of candidates) if (typeof c === 'string' && VERSION.test(c.trim())) return c.trim();
  for (const c of candidates) {
    const m = typeof c === 'string' ? /\d{1,6}\.\d{1,6}\.\d{1,6}/.exec(c) : null;
    if (m) return m[0];
  }
  return null;
}

// Lexical normalisation, when $.fs.stat cannot resolve a real path.
function normalise(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

function parentOf(dir) {
  if (dir === '/') return null;
  const i = dir.lastIndexOf('/');
  return i <= 0 ? '/' : dir.slice(0, i);
}


// ── the mod's state ─────────────────────────────────────────────────────────
//
// Claude Code 2.1.296 scans this module before it loads it, and follows `$`
// only into functions declared at the top of this file: so every function
// that reaches `$` is declared here, takes it as its first parameter (a plain
// name) beside the state `st`, and spells every use $.noun.event(...). `$` is
// never stored — not on `st`, not in a variable — and never handed to
// anything but such a function. test/claude-mod-scan.test.js holds the file
// to those rules.

function newState() {
  return {
    began: false,
    ended: false,
    idle: false, // nothing more to do this session (no project, or the bridge said stop)
    cwd: null,
    home: null,
    project: undefined, // the directory holding .web-chat/; null: none found
    realRoot: null,
    sid: null,
    endedSid: null, // the id a clear/resume ended, while the next one is awaited
    switchReads: 0,
    switchUntil: 0,
    recheck: false, // a main-thread turn started: compare the session id before the next batch goes
    ccVersion: null,
    disabled: false,
    token: null,
    port: null,
    hello: null,
    failures: 0,
    driver: null, // 'loop' | 'clock'
    startReturned: false,
    loopFailed: false,
    needClock: false,
    checks: 0,
    busy: false,
    nextAt: 0,
    timers: new Set(), // every $.clock timer armed and not yet fired or cancelled
    waits: new Set(), // every pending wait(), so the end can release it
    pending: [],
    flushing: false,
    flushArmed: false,
    counters: { dropped: 0, failed: 0 },
    openTurn: null,
    inflight: new Map(), // tool_use_id → a running tool call
    permWaiters: new Map(), // request_id → resolve(decision)
    seq: 0,
    shapes: {},
    diagSent: false,
  };
}

// ── timers, all through $.clock and all tracked ─────────────────────────────

function armAfter($, st, ms, fn) {
  let handle = null;
  const t = { cancel: () => { st.timers.delete(t); try { if (handle) handle.cancel(); } catch {} } };
  handle = $.clock.after(Math.max(1, ms), () => {
    st.timers.delete(t);
    return fn();
  });
  st.timers.add(t);
  return t;
}

function armEvery($, st, ms, fn) {
  let handle = null;
  const t = { cancel: () => { st.timers.delete(t); try { if (handle) handle.cancel(); } catch {} } };
  handle = $.clock.every(Math.max(1, ms), fn);
  st.timers.add(t);
  return t;
}

// Resolves true after `ms`, or false when the mod ends first; rejects when
// $.clock refuses (the caller's driver logic reads why).
function wait($, st, ms) {
  return new Promise((resolve, reject) => {
    if (st.ended) { resolve(false); return; }
    const w = { timer: null, resolve };
    st.waits.add(w);
    try {
      w.timer = armAfter($, st, ms, () => { st.waits.delete(w); resolve(true); });
    } catch (e) {
      st.waits.delete(w);
      reject(e);
    }
  });
}

// `p`, or null once `ms` passes; the timer goes when `p` settles first.
function within($, st, p, ms) {
  let w = null;
  const timeout = new Promise((resolve) => {
    if (st.ended) { resolve(null); return; }
    w = { timer: null, resolve: () => resolve(null) };
    st.waits.add(w);
    try { w.timer = armAfter($, st, ms, () => { st.waits.delete(w); resolve(null); }); } catch { st.waits.delete(w); resolve(null); }
  });
  return Promise.race([p, timeout]).finally(() => {
    if (w) { st.waits.delete(w); if (w.timer) w.timer.cancel(); }
  });
}

function endAll(st) {
  st.ended = true;
  st.token = null;
  for (const t of [...st.timers]) t.cancel();
  for (const w of [...st.waits]) { st.waits.delete(w); if (w.timer) w.timer.cancel(); w.resolve(false); }
  for (const resolve of st.permWaiters.values()) resolve(null);
  st.permWaiters.clear();
}

// ── every $ call the loop makes ─────────────────────────────────────────────
//
// Each one is written out where it is made, behind alive(st), and a failure
// goes through fault(): a call that fails while the detached loop drives is
// asked whether it failed for being outside a hook (a probe that never fails
// inside one): then the clock takes over.

function alive(st) {
  if (st.ended) throw STOP;
}

function marker(e) {
  return e === OUTSIDE || e === STOP;
}

// Is the mod outside any hook now? A $ call that never rejects inside one.
async function outsideHook($, st) {
  try { await $.clock.now(); return false; } catch (e) {
    if (isUnloaded(e)) { endAll(st); return false; }
    return true;
  }
}

// What a failed $ call throws on: STOP (the environment is unloaded), OUTSIDE
// (the detached loop was refused outside a hook), or the error itself.
async function fault($, st, e) {
  if (isUnloaded(e)) { endAll(st); return STOP; }
  if (st.driver === 'loop' && st.startReturned && await outsideHook($, st)) return OUTSIDE;
  return e;
}

// ── the gate ────────────────────────────────────────────────────────────────

async function exists($, st, p) {
  alive(st);
  try { return (await $.fs.exists(p)) === true; } catch (e) {
    const x = await fault($, st, e);
    if (marker(x)) throw x;
    return false;
  }
}

async function realOf($, st, p) {
  alive(st);
  try {
    const s = await $.fs.stat(p, { resolve: true });
    if (s && typeof s.realPath === 'string' && s.realPath.startsWith('/')) return normalise(s.realPath);
  } catch (e) {
    const x = await fault($, st, e);
    if (marker(x)) throw x;
  }
  return normalise(p);
}

// The nearest directory above the session's holding a .web-chat/, never
// $HOME (its .web-chat/ is web-chat's per-user folder, not a project).
async function findProject($, st, start) {
  let dir = normalise(start);
  const home = normalise(st.home);
  while (dir) {
    if (dir !== home && await exists($, st, `${dir === '/' ? '' : dir}/.web-chat`)) return dir;
    dir = parentOf(dir);
  }
  return null;
}

async function isDisabled($, st) {
  const checks = [`${st.project}/.web-chat/disabled`];
  if (st.home) {
    checks.push(`${st.home}/.web-chat/disabled`);
    if (st.sid && SAFE_ID.test(st.sid)) checks.push(`${st.home}/.web-chat/sessions/${st.sid}.json`);
  }
  for (const p of checks) if (await exists($, st, p)) return true;
  return false;
}

// The port of THIS project's daemon, or null: a record naming another root,
// or none, is no daemon of this project (decided 2026-10-13,
// T6-refresh@mod-portfile-identity).
async function readPort($, st) {
  const file = `${st.project}/.web-chat/server.json`;
  if (!await exists($, st, file)) return null;
  let text;
  alive(st);
  try { text = await $.fs.read(file); } catch (e) {
    const x = await fault($, st, e);
    if (marker(x)) throw x;
    return null;
  }
  let rec;
  try { rec = JSON.parse(text); } catch { return null; }
  if (!isPlain(rec) || !Number.isInteger(rec.port) || rec.port < 1 || rec.port > 65535) return null;
  if (typeof rec.root !== 'string' || !rec.root) return null;
  if (await realOf($, st, rec.root) !== st.realRoot) return null;
  return rec.port;
}

// The session's facts, each read once: HOME, its directory, Claude Code's
// version and the session id.
async function readHome($, st) {
  alive(st);
  try { return (await $.env.get('HOME')) || null; } catch (e) { throw await fault($, st, e); }
}

async function readCwd($, st) {
  alive(st);
  try { return await $.session.cwd(); } catch (e) { throw await fault($, st, e); }
}

async function readVersion($, st) {
  alive(st);
  try { return await $.session.version(); } catch (e) { throw await fault($, st, e); }
}

async function readSessionId($, st) {
  alive(st);
  try { return await $.session.id(); } catch (e) { throw await fault($, st, e); }
}

// ── the wire ────────────────────────────────────────────────────────────────

async function fetchJson($, st, method, port, path, body, withToken) {
  const init = { method, headers: {} };
  if (body !== null && body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (withToken) init.headers['x-wc-bridge'] = st.token;
  alive(st);
  let res;
  try { res = await $.http.fetch(`http://${LOOPBACK}:${port}${path}`, init); } catch (e) { throw await fault($, st, e); }
  let parsed = null;
  try { parsed = JSON.parse(res && typeof res.text === 'string' ? res.text : ''); } catch {}
  return { status: res ? res.status : 0, body: parsed };
}

function helloBody(st) {
  return {
    v: 1,
    protocol: WIRE.MOD_PROTOCOL,
    session_id: st.sid,
    cc_version: st.ccVersion,
    mod_version: MOD_VERSION,
    ops: [...WIRE.OPS],
    events: [...WIRE.EVENT_KINDS],
    root: st.project,
  };
}

// After a clear/resume end: has the process moved off the ended id, or has
// the wait run out (by reads, or by the clock)? Then the id read is the one
// to say hello with.
function switchSettled(st, sid) {
  if (sid && sid.toLowerCase() !== st.endedSid.toLowerCase()) return true;
  st.switchReads += 1;
  return st.switchReads >= SWITCH_READS || Date.now() >= st.switchUntil;
}

// What belonged to the session the mod leaves: its open requests answer
// null (the terminal takes them), and the next hello sends a fresh diag.
function leaveSession(st) {
  st.token = null;
  st.diagSent = false;
  for (const resolve of st.permWaiters.values()) resolve(null);
  st.permWaiters.clear();
}

function backoff(st) {
  const ms = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(st.failures, 16));
  st.failures += 1;
  st.token = null;
  return ms;
}

function lost(st) {
  st.token = null;
}

// One step of the op loop; the ms to wait before the next, or null when
// there is nothing more to do this session.
async function step($, st) {
  if (st.ended || st.idle) return null;
  if (st.project === undefined) {
    if (!st.home) st.home = await readHome($, st);
    if (!st.cwd) st.cwd = await readCwd($, st);
    // Settled together, so a gate cut short (the fallback driver takes
    // over) is run again whole.
    const project = await findProject($, st, st.cwd);
    if (!project) { st.project = null; st.idle = true; st.pending.length = 0; return null; }
    const realRoot = await realOf($, st, project);
    const ccVersion = versionOf(await readVersion($, st));
    st.realRoot = realRoot;
    st.ccVersion = ccVersion;
    st.project = project;
    // No version to say hello with: the bridge would refuse every hello.
    if (!ccVersion) { st.idle = true; st.pending.length = 0; return null; }
  }
  if (!st.sid) {
    const read = await readSessionId($, st);
    const sid = typeof read === 'string' && UUID.test(read) ? read : null;
    if (st.endedSid && !switchSettled(st, sid)) return SWITCH_POLL_MS;
    st.endedSid = null;
    st.sid = sid;
    if (!st.sid) { st.idle = true; return null; }
  }
  if (await isDisabled($, st)) {
    st.disabled = true;
    st.pending.length = 0;
    lost(st);
    return RECHECK_MS;
  }
  st.disabled = false;

  if (!st.token) {
    const port = await readPort($, st);
    if (!port) return backoff(st);
    let r;
    try { r = await fetchJson($, st, 'POST', port, '/api/bridge/hello', helloBody(st), false); } catch (e) { if (marker(e)) throw e; return backoff(st); }
    const b = r.body || {};
    if (r.status === 200 && typeof b.token === 'string' && b.token) {
      st.token = b.token;
      st.port = port;
      st.hello = b;
      st.failures = 0;
      void flush($, st).catch(() => {}); // what waited for the hello goes at once
      return 0;
    }
    if (r.status === 409 && (b.refused === 'protocol' || b.refused === 'too-old')) { st.idle = true; st.pending.length = 0; return null; }
    if (r.status === 409 && b.refused === 'disabled') {
      const ms = Number.isFinite(b.retry_ms) && b.retry_ms > 0 ? Math.min(b.retry_ms, 600000) : RECHECK_MS;
      return ms;
    }
    return backoff(st); // wrong-project, a 5xx, anything else: as a network failure
  }

  const waitMs = Math.min(WIRE.OPS_WAIT_MAX_MS, Math.max(0, Number(st.hello && st.hello.wait_max_ms) || WIRE.OPS_WAIT_MAX_MS));
  let r;
  try { r = await fetchJson($, st, 'GET', st.port, `/api/bridge/ops?wait=${Math.floor(waitMs)}`, null, true); } catch (e) { if (marker(e)) throw e; return backoff(st); }
  if (r.status === 401) { lost(st); return 0; }
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.ops)) return backoff(st);
  st.failures = 0;
  for (const op of r.body.ops) {
    if (st.ended) break;
    await runOp($, st, op);
  }
  return 0;
}

// ── the drivers ─────────────────────────────────────────────────────────────

// The detached loop: started from session.start and never awaited there.
async function runLoop($, st) {
  st.driver = 'loop';
  try {
    while (!st.ended && st.driver === 'loop') {
      const ms = await step($, st);
      if (ms === null) return;
      if (ms > 0 && !await wait($, st, ms)) return;
    }
  } catch (e) {
    if (e === STOP || isUnloaded(e)) { endAll(st); return; }
    // OUTSIDE (Claude Code refused a call made outside a hook), or anything
    // else: the clock takes over rather than leave the session without a
    // bridge — now if $.clock still answers here, else from the driver
    // check's timer or the next hook that runs.
    st.loopFailed = true;
    try { startClock($, st); } catch { st.needClock = true; }
  }
}

function clockTick($, st) {
  if (st.ended || st.busy || Date.now() < st.nextAt) return undefined;
  st.busy = true;
  return step($, st).then(
    (ms) => {
      if (ms === null) { for (const t of [...st.timers]) t.cancel(); return; }
      st.nextAt = Date.now() + ms;
    },
    (e) => {
      if (e === STOP) return;
      st.nextAt = Date.now() + 1000;
    },
  ).finally(() => { st.busy = false; });
}

// Throws when $.clock refuses (outside a hook): the caller tries again from
// inside one. The clock's steps run on the `$` of the hook that armed it.
function startClock($, st) {
  if (st.ended || st.driver === 'clock') return;
  st.nextAt = 0;
  armEvery($, st, CLOCK_TICK_MS, () => clockTick($, st));
  st.driver = 'clock';
  st.needClock = false;
}

// From inside any hook: the fallback a failed loop could not arm itself.
function maybeClock($, st) {
  if (!st.needClock || st.ended) return;
  try { startClock($, st); } catch {}
}

// Runs on a $.clock timer armed in session.start — inside a dispatch Claude
// Code scheduled — a few times, so a loop that cannot run outside a hook is
// replaced by the clock at once rather than at the next event.
function checkDriver($, st) {
  if (st.ended || st.idle || st.driver !== 'loop') return;
  if (st.loopFailed) { try { startClock($, st); } catch { st.needClock = true; } return; }
  st.checks += 1;
  if (st.checks >= DRIVER_CHECKS) return;
  try { armAfter($, st, DRIVER_CHECK_MS, () => checkDriver($, st)); } catch {}
}

// ── events ──────────────────────────────────────────────────────────────────

function active(st) {
  return !st.ended && st.project !== null && !st.disabled && !st.idle;
}

function push($, st, kind, fields) {
  if (!active(st)) return;
  try {
    const ev = { kind, at: Date.now() };
    for (const k of Object.keys(fields)) if (fields[k] !== undefined) ev[k] = fields[k];
    const last = st.pending[st.pending.length - 1];
    if (kind === 'turn.step' && last && last.kind === 'turn.step' && last.turn_id === ev.turn_id
      && last.index === ev.index && last.message_id === ev.message_id && last.agent_id === ev.agent_id
      && last.delta.length + ev.delta.length <= WIRE.DELTA_MAX) {
      last.delta += ev.delta;
      return;
    }
    st.pending.push(ev);
    while (st.pending.length > PENDING_MAX) { st.pending.shift(); st.counters.dropped += 1; }
    if (st.pending.length >= WIRE.BATCH_MAX) void flush($, st).catch(() => {});
    else scheduleFlush($, st);
  } catch { st.counters.failed += 1; }
}

function flushMs(st) {
  const v = Number(st.hello && st.hello.flush_ms);
  return Number.isFinite(v) && v >= 10 && v <= 5000 ? v : WIRE.FLUSH_MS;
}

function scheduleFlush($, st) {
  if (st.flushArmed || !st.token || !st.pending.length || st.ended) return;
  try {
    st.flushArmed = true;
    armAfter($, st, flushMs(st), () => { st.flushArmed = false; return flush($, st).catch(() => {}); });
  } catch { st.flushArmed = false; }
}

function takeBatch(st) {
  const batch = [];
  let bytes = 0;
  while (st.pending.length && batch.length < WIRE.BATCH_MAX) {
    const n = jsonLen(st.pending[0]) + 1;
    if (n > BATCH_BYTES) { st.pending.shift(); st.counters.dropped += 1; continue; }
    if (bytes + n > BATCH_BYTES) break;
    batch.push(st.pending.shift());
    bytes += n;
  }
  return batch;
}

// turn.start's check, made where events leave for the bridge, so it never
// holds up the turn and no event of that turn goes out as the wrong session:
// a process Claude Code moved to another session id with no end the mod saw
// (or later than the wait after one) ends the old session at the bridge
// first — session.end, under the old token, ahead of anything waiting — and
// says hello as the new one; what waits goes after that hello.
async function recheckSession($, st) {
  st.recheck = false;
  if (!st.sid || !st.token || st.endedSid) return;
  let read;
  try { read = await readSessionId($, st); } catch (e) { if (marker(e)) throw e; return; }
  if (typeof read !== 'string' || !UUID.test(read) || read.toLowerCase() === st.sid.toLowerCase() || !st.token) return;
  const token = st.token;
  st.sid = read; // a hello from here on is the new session's
  try {
    await fetchJson($, st, 'POST', st.port, '/api/bridge/events', { events: [{ kind: 'session.end', at: Date.now(), reason: 'switch' }] }, true);
  } catch (e) { if (marker(e)) throw e; }
  if (st.token === token) leaveSession(st);
}

async function flush($, st) {
  if (st.flushing || !st.token || !st.pending.length) return;
  st.flushing = true;
  try {
    while (st.pending.length && st.token) {
      if (st.recheck) { await recheckSession($, st); if (!st.token) break; }
      const batch = takeBatch(st);
      if (!batch.length) break;
      let r;
      try { r = await fetchJson($, st, 'POST', st.port, '/api/bridge/events', { events: batch }, true); } catch (e) {
        st.counters.failed += batch.length;
        if (marker(e)) throw e;
        break;
      }
      if (r.status === 401) { st.counters.failed += batch.length; lost(st); break; }
      if (r.status !== 200) st.counters.failed += batch.length;
    }
  } finally {
    st.flushing = false;
  }
  scheduleFlush($, st);
}

function shape(st, kind, paths) {
  if (st.shapes[kind] || !paths.length) return;
  st.shapes[kind] = paths.slice(0, SHAPE_PATHS);
}

function sendDiag($, st) {
  if (st.diagSent) return;
  st.diagSent = true;
  const driver = st.driver || 'loop';
  // The bridge keeps only `shapes` of a diag (validateEvent), so the driver
  // and the two counters ride inside it as one-entry lists: how many events
  // this mod dropped (over the 200 waiting, or one too big for a batch) and
  // how many it failed to send or build, up to this diag.
  push($, st, 'diag', {
    shapes: {
      ...st.shapes,
      driver: [driver],
      dropped: [String(st.counters.dropped)],
      failed: [String(st.counters.failed)],
    },
    driver,
  });
}

// One chunk turn.step's stream yielded: its key names once per kind, and its
// text forwarded as deltas.
function lookChunk($, st, c, turnId, index, agentId) {
  try {
    if (!isPlain(c)) return;
    const kind = typeof c.kind === 'string' && WORD.test(c.kind) ? c.kind : 'chunk';
    if (!st.shapes['turn.step'] || !st.shapes['turn.step'].some((p) => p.startsWith(`${kind}.`))) {
      st.shapes['turn.step'] = [...(st.shapes['turn.step'] || []), ...Object.keys(c).map((k) => `${kind}.${k}`).filter((p) => SHAPE_KEY.test(p))].slice(0, SHAPE_PATHS);
    }
    if (c.kind !== 'text' || typeof c.text !== 'string' || !c.text || !turnId) return;
    const mid = idOr(c.messageId) || idOr(c.message_id) || (isPlain(c.message) ? idOr(c.message.id) : undefined);
    for (let i = 0; i < c.text.length; i += WIRE.DELTA_MAX) {
      push($, st, 'turn.step', { turn_id: turnId, index, message_id: mid, delta: c.text.slice(i, i + WIRE.DELTA_MAX), agent_id: agentId });
    }
  } catch { st.counters.failed += 1; }
}

function finishTool($, st, rec, r, threw) {
  try {
    if (!rec) return;
    st.inflight.delete(rec.id);
    rec.settle(r || null);
    const bg = r && r.result && typeof r.result.backgroundTaskId === 'string' ? r.result.backgroundTaskId : undefined;
    push($, st, 'tool.done', {
      tool_use_id: rec.id,
      ok: !threw && !!r && typeof r.deny !== 'string' && !r.isError,
      is_error: threw || !!(r && (r.isError || typeof r.deny === 'string')),
      duration_ms: Math.max(0, Date.now() - rec.t0),
      background_task_id: bg && TASK_ID.test(bg) ? bg : undefined,
      agent_id: rec.agentId,
    });
  } catch { st.counters.failed += 1; }
}

// ── ops ─────────────────────────────────────────────────────────────────────

function refused(word, error) {
  return { ok: false, refused: word, ...(error ? { error: cut(error, WIRE.ERROR_MAX) } : {}) };
}

function done(result) {
  return { ok: true, result };
}

async function stopTask($, st, taskId) {
  alive(st);
  let t;
  try { t = await $.tool.call({ tool: 'TaskStop', task_id: taskId }); } catch (e) { throw await fault($, st, e); }
  if (t && typeof t.deny === 'string') return { ok: false, error: t.deny };
  if (t && t.isError) return { ok: false, error: typeof t.text === 'string' ? t.text : 'TaskStop failed' };
  return { ok: true };
}

// Stops one foreground Bash call the abort left running backgrounded; its
// task id, or null.
async function stopSettled($, st, c) {
  const r = await within($, st, c.done, ABORT_SETTLE_MS);
  const id = r && r.result && typeof r.result.backgroundTaskId === 'string' ? r.result.backgroundTaskId : null;
  if (!id || !TASK_ID.test(id)) return null;
  try { if ((await stopTask($, st, id)).ok) return id; } catch (e) { if (marker(e)) throw e; }
  return null;
}

async function opAbort($, st) {
  const turnId = st.openTurn;
  if (!turnId) return refused('no-turn');
  // The foreground Bash calls running now: the abort settles them.
  const foreground = [...st.inflight.values()].filter((c) => c.foreground);
  alive(st);
  try { await $.turn.abort({ turnId }); } catch (err) {
    const e = await fault($, st, err);
    if (marker(e)) throw e;
    return /no turn is running|not the running turn|already ending/i.test(messageOf(e)) ? refused('no-turn', messageOf(e)) : refused('failed', messageOf(e));
  }
  // $.turn.abort backgrounds a running foreground Bash rather than kill it
  // (spec §15.2): stop each one that settles backgrounded.
  const stopped = [];
  const settled = [];
  for (const c of foreground) settled.push(stopSettled($, st, c));
  for (const id of await Promise.all(settled)) if (id) stopped.push(id);
  return done({ aborted: true, stopped });
}

async function opTaskStop($, st, a) {
  if (!TASK_ID.test(a.task_id || '')) return refused('bad-args');
  const r = await stopTask($, st, a.task_id);
  return r.ok ? done({ stopped: true }) : refused('failed', r.error);
}

// $.prompt.submit and $.command.run, settled as {v} or {e} — never a
// rejection, so the op can answer before they resolve.
async function submitText($, st, text) {
  if (st.ended) return { e: STOP };
  try { return { v: await $.prompt.submit({ text, asUser: true }) }; } catch (e) { return { e: await fault($, st, e) }; }
}

async function runCommand($, st, input) {
  if (st.ended) return { e: STOP };
  try { return { v: await $.command.run(input) }; } catch (e) { return { e: await fault($, st, e) }; }
}

// Why $.prompt.submit's answer says Claude Code did NOT take the prompt, or
// null. Claude Code 2.1.29x resolves a refused submit rather than reject it:
// {ended: 'Prompt not submitted: …'} or {ended: 'Prompt dropped by a hook: …'}
// (its pipeline's `ended` may also be an object carrying resultText), and a
// prompt that never went through prompt.submit settles {drop: '…'}. Each is a
// prompt that will never run, so it must not read as submitted: the daemon
// hands it back to the channel or the park.
function notSubmitted(v) {
  if (!isPlain(v)) return null;
  const end = v.ended;
  if (typeof end === 'string') return end || 'Prompt not submitted';
  if (isPlain(end) && typeof end.resultText === 'string' && end.resultText) return end.resultText;
  if (end !== undefined && end !== null && end !== false) return 'Prompt not submitted';
  if (typeof v.drop === 'string') return v.drop || 'Prompt dropped';
  return null;
}

async function opSubmit($, st, a) {
  const text = a.text;
  if (typeof text !== 'string' || !text.trim() || text.length > WIRE.ARG_TEXT_MAX) return refused('bad-args');
  if (text.trimStart().startsWith('/')) return refused('not-allowed', 'a text beginning with / would run as a command');
  const r = await within($, st, submitText($, st, text), SUBMIT_WAIT_MS);
  if (!r) return done({ submitted: true, queued: true });
  if (r.e) { if (marker(r.e)) throw r.e; return refused('failed', messageOf(r.e)); }
  if (r.v && typeof r.v.deny === 'string') return refused('denied', r.v.deny);
  const why = notSubmitted(r.v);
  if (why) return refused('not-submitted', why);
  return done({ submitted: true });
}

async function opCommand($, st, a) {
  const name = a.name;
  if (typeof name !== 'string' || !WIRE.MOD_COMMANDS.includes(name)) return refused('not-allowed');
  if (a.args !== undefined && a.args !== null && typeof a.args !== 'string') return refused('bad-args');
  if (typeof a.args === 'string' && (a.args.length > (name === 'rename' ? WIRE.RENAME_MAX : WIRE.COMMAND_ARGS_MAX) || /[\r\n]/.test(a.args))) return refused('bad-args');
  const input = typeof a.args === 'string' && a.args ? { command: name, args: a.args } : { command: name };
  const r = await within($, st, runCommand($, st, input), COMMAND_WAIT_MS);
  if (!r) return done({ ran: true, pending: true });
  if (r.e) { if (marker(r.e)) throw r.e; return refused('failed', messageOf(r.e)); }
  if (r.v && typeof r.v.deny === 'string') return refused('denied', r.v.deny);
  return done({ ran: true });
}

async function opFill($, st, a) {
  if (typeof a.text !== 'string' || a.text.length > WIRE.ARG_TEXT_MAX) return refused('bad-args');
  alive(st);
  let r;
  try { r = await $.prompt.fill({ text: a.text, mode: 'replace' }); } catch (e) { throw await fault($, st, e); }
  return done({ filled: !(r && r.isFilled === false) });
}

function opPermissionDecision(st, a) {
  if (!SAFE_ID.test(a.request_id || '') || !isPlain(a.decision)) return refused('bad-args');
  if (forbiddenDecision(a.decision)) return refused('not-allowed');
  const resolve = st.permWaiters.get(a.request_id);
  if (!resolve) return refused('no-request');
  st.permWaiters.delete(a.request_id);
  resolve(a.decision);
  return done({ answered: true });
}

async function opUsage($, st) {
  alive(st);
  let u;
  try { u = await $.session.usage(); } catch (e) { throw await fault($, st, e); }
  return done(numbersOnly(u) || {});
}

async function opMessages($, st) {
  alive(st);
  let m;
  try { m = await $.session.messages(); } catch (e) { throw await fault($, st, e); }
  return done({ count: Array.isArray(m) ? m.length : null });
}

async function doOp($, st, op) {
  if (typeof op.expires_at === 'number' && op.expires_at < Date.now()) return refused('expired');
  if (typeof op.op !== 'string' || !WIRE.OPS.includes(op.op)) return refused('not-allowed');
  const a = isPlain(op.args) ? op.args : {};
  switch (op.op) {
    case 'abort': return opAbort($, st);
    case 'taskStop': return opTaskStop($, st, a);
    case 'submit': return opSubmit($, st, a);
    case 'command': return opCommand($, st, a);
    case 'fill': return opFill($, st, a);
    case 'permissionDecision': return opPermissionDecision(st, a);
    case 'usage': return opUsage($, st);
    case 'messages': return opMessages($, st);
    default: return refused('not-allowed');
  }
}

async function runOp($, st, op) {
  if (!isPlain(op) || typeof op.id !== 'string') return;
  let out;
  try { out = await doOp($, st, op); } catch (e) {
    if (marker(e)) throw e;
    out = refused('failed', messageOf(e));
  }
  if (out.ok && jsonLen(out.result) > WIRE.RESULT_MAX) out = refused('too-large');
  try { await fetchJson($, st, 'POST', st.port, '/api/bridge/result', { id: op.id, ...out }, true); } catch (e) { if (marker(e)) throw e; }
}

// ── the session ─────────────────────────────────────────────────────────────

// session.start, once: the session.start event, the driver check's timer and
// the detached op loop (never awaited: $.command.run refuses to run inside a
// hook that holds a turn).
function begin($, st, e) {
  if (st.began) return;
  st.began = true;
  st.cwd = e && typeof e.cwd === 'string' ? e.cwd : null;
  push($, st, 'session.start', {});
  try { armAfter($, st, DRIVER_CHECK_MS, () => checkDriver($, st)); } catch {}
  void runLoop($, st);
}

async function endSession($, st, reason) {
  st.recheck = false; // the end itself says what became of the session
  push($, st, 'session.end', { reason: typeof reason === 'string' && WORD.test(reason) ? reason : undefined });
  try { await within($, st, flush($, st), 1000); } catch {}
  if (reason === 'clear' || reason === 'resume') {
    // The process goes on under another session id, and no session.start
    // fires for it: say hello again as that session — once Claude Code has
    // switched to it (step waits on switchSettled), never as the ended one.
    st.endedSid = st.sid || st.endedSid;
    st.switchReads = 0;
    st.switchUntil = Date.now() + SWITCH_WAIT_MS;
    leaveSession(st);
    st.sid = null;
    st.openTurn = null;
    st.inflight.clear();
    // A session.end the flush did not get out belongs to the old token: sent
    // after the new hello it would detach the new session.
    for (let i = st.pending.length - 1; i >= 0; i--) if (st.pending[i].kind === 'session.end') st.pending.splice(i, 1);
    return;
  }
  endAll(st);
}

function onToolCall($, st, e) {
  maybeClock($, st);
  let rec = null;
  try {
    const id = idOr(e && e.tool_use_id);
    if (active(st) && id && typeof e.tool === 'string' && e.tool) {
      const args = {};
      for (const k of Object.keys(e)) if (k !== 'tool' && k !== 'tool_use_id' && k !== 'agentId' && k !== 'consent') args[k] = e[k];
      shape(st, 'tool.call', keyPaths(e));
      push($, st, 'tool.call', { tool_use_id: id, tool: cut(e.tool, 200), input: bounded(args, WIRE.INPUT_MAX), agent_id: idOr(e.agentId) });
      rec = {
        id, t0: Date.now(), agentId: idOr(e.agentId),
        foreground: e.tool === 'Bash' && e.run_in_background !== true,
        settle: null, done: null,
      };
      rec.done = new Promise((resolve) => { rec.settle = resolve; });
      st.inflight.set(id, rec);
    }
  } catch { st.counters.failed += 1; rec = null; }
  return rec;
}

function onAppend($, st, e, r) {
  try {
    const uuid = r && typeof r.uuid === 'string' ? r.uuid : (e && e.uuid);
    const message = rowOf((r && r.message) || (e && e.message));
    shape(st, 'session.append', keyPaths(e));
    if (typeof uuid === 'string' && UUID.test(uuid) && message) {
      push($, st, 'session.append', { uuid, origin: originOf(e && e.origin), message, agent_id: idOr(e && e.agentId) });
    }
  } catch { st.counters.failed += 1; }
}

// classic.PermissionRequest: { id, waitMs } of the request forwarded and to be
// waited on, or null (no wait asked, no bridge, no tool name): then the
// terminal answers.
function forwardPermission($, st, e) {
  try {
    const waitMs = Math.min(WIRE.PERMISSION_WAIT_MAX_MS, Math.max(0, Math.floor(Number(st.hello && st.hello.permission_wait_ms) || 0)));
    if (waitMs > 0 && st.token && active(st) && e && typeof e.tool_name === 'string' && e.tool_name) {
      st.seq += 1;
      const id = `pr_${Date.now().toString(36)}_${st.seq}`;
      push($, st, 'permission.request', {
        request_id: id, tool: cut(e.tool_name, 200), tool_use_id: idOr(e.tool_use_id), input: bounded(e.tool_input, WIRE.INPUT_MAX),
      });
      void flush($, st).catch(() => {});
      return { id, waitMs };
    }
  } catch {}
  return null;
}

async function awaitDecision($, st, id, waitMs) {
  let decision = null;
  try {
    const answered = new Promise((resolve) => { st.permWaiters.set(id, resolve); });
    decision = await within($, st, answered, waitMs);
  } catch { decision = null; }
  st.permWaiters.delete(id);
  return decision;
}

// ── the hooks (every one passes `e` on and returns what next(e) returned) ───

export function register(on) {
  const st = newState();

  on('session.start', async ($, e, next) => {
    const r = await next(e);
    try { begin($, st, e); } catch { st.counters.failed += 1; }
    st.startReturned = true;
    return r;
  });

  on('session.end', async ($, e, next) => {
    maybeClock($, st);
    let r;
    try { r = await next(e); } finally {
      try { await endSession($, st, e && e.reason); } catch { endAll(st); }
    }
    return r;
  });

  on('turn.start', ($, e, next) => {
    maybeClock($, st);
    try {
      if (e && !e.agentId && typeof e.turnId === 'string') st.openTurn = e.turnId;
      // A switch the end's wait missed, or one with no end: flush compares
      // the id before this turn's first event goes (never awaited here).
      if (e && !e.agentId) st.recheck = true;
      push($, st, 'turn.start', { turn_id: idOr(e && e.turnId), agent_id: idOr(e && e.agentId) });
    } catch { st.counters.failed += 1; }
    return next(e);
  });

  on('turn.step', async function* turnStep($, e, next) {
    const stream = next(e);
    const inner = stream[Symbol.asyncIterator]();
    const turnId = idOr(e && e.turnId);
    const index = e && Number.isSafeInteger(e.index) ? e.index : 0;
    const agentId = idOr(e && e.agentId);
    // Every chunk next() yields is yielded up unchanged, in order; a return or
    // throw from above reaches the stream beneath.
    const observed = {
      [Symbol.asyncIterator]() { return this; },
      async next(v) {
        const r = await inner.next(v);
        if (!r.done) lookChunk($, st, r.value, turnId, index, agentId);
        return r;
      },
      return(v) { return typeof inner.return === 'function' ? inner.return(v) : Promise.resolve({ done: true, value: v }); },
      throw(err) { return typeof inner.throw === 'function' ? inner.throw(err) : Promise.reject(err); },
    };
    return yield* observed;
  });

  on('turn.complete', ($, e, next) => {
    maybeClock($, st);
    try {
      if (e && st.openTurn === e.turnId) st.openTurn = null;
      shape(st, 'turn.complete', keyPaths(e));
      push($, st, 'turn.complete', {
        turn_id: idOr(e && e.turnId),
        reason: e && typeof e.reason === 'string' && WORD.test(e.reason) ? e.reason : undefined,
        text: e && typeof e.answer === 'string' ? cut(e.answer, WIRE.TEXT_MAX) : undefined,
        usage: usageOf(e && e.usage),
        agent_id: idOr(e && e.agentId),
      });
      if (e && !e.agentId) sendDiag($, st);
    } catch { st.counters.failed += 1; }
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    const rec = onToolCall($, st, e);
    let r;
    try {
      r = await next(e);
    } catch (err) {
      finishTool($, st, rec, null, true);
      throw err;
    }
    finishTool($, st, rec, r, false);
    return r;
  });

  on('session.append', async ($, e, next) => {
    maybeClock($, st);
    const r = await next(e);
    onAppend($, st, e, r);
    return r;
  });

  on('session.compact', async ($, e, next) => {
    const trigger = e && typeof e.trigger === 'string' && WORD.test(e.trigger) ? e.trigger : 'unknown';
    try { push($, st, 'session.compact', { trigger, phase: 'start', agent_id: idOr(e && e.agentId) }); } catch {}
    let r;
    try { r = await next(e); } catch (err) {
      try { push($, st, 'session.compact', { trigger, phase: 'failed', agent_id: idOr(e && e.agentId) }); } catch {}
      throw err;
    }
    try { push($, st, 'session.compact', { trigger, phase: r && r.skip ? 'skipped' : 'end', agent_id: idOr(e && e.agentId) }); } catch {}
    return r;
  });

  on('session.measure', ($, e, next) => {
    try {
      const fields = {};
      if (e && Array.isArray(e.changed)) fields.changed = e.changed.filter((x) => typeof x === 'string' && WORD.test(x)).slice(0, 16);
      const context = numbersOnly(e && e.context);
      if (context) fields.context = context;
      const cost = numbersOnly(e && e.cost);
      if (cost) fields.cost = cost;
      push($, st, 'session.measure', fields);
    } catch { st.counters.failed += 1; }
    return next(e);
  });

  on('prompt.submit', ($, e, next) => {
    maybeClock($, st);
    try {
      const origin = originOf(e && e.origin);
      if (origin) push($, st, 'prompt.submit', { origin });
    } catch { st.counters.failed += 1; }
    return next(e);
  });

  on('classic.PermissionRequest', async ($, e, next) => {
    const asked = forwardPermission($, st, e);
    if (!asked) return next(e);
    const id = asked.id;
    const decision = await awaitDecision($, st, id, asked.waitMs);
    if (decision && !isPass(decision)) {
      push($, st, 'permission.settled', { request_id: id, by: 'web' });
      return decision.behavior ? { decision } : (isPlain(decision.decision) ? decision : { decision });
    }
    push($, st, 'permission.settled', { request_id: id, by: decision ? 'terminal' : 'timeout' });
    return next(e);
  });
}

// The relay credential and the relay secret's intake (contract 03 C-03.19 to
// C-03.22, C-03.24; contract 11 C-11.7; tranche 6 U741). OQ-1 (B), ruled
// 2026-10-28: the daemon is the second lock. A request relayed by the
// connector that supervises this daemon carries the relay secret the connector
// handed it at spawn; only such a request may later be read at the level the
// hub stamped (04 C-04.10, C-04.11 — lib/server/audience, not here). The tunnel
// path keeps 0.9's rule: a portal request carries no relay secret.
//
//   takeRelaySecret({env, fs, sleep, onTaken}) → the secret, or null
//     Called ONCE per process, as the first thing the foreground start does
//     (lib/cli/commands/start.js, through lib/server/index.js), before anything
//     can fork a child: a service child forks with this process's env and its
//     own fd 3 is its IPC channel (lib/server/services.js), and a restarted or
//     --daemon child inherits the env.
//       * WEB_CHAT_RELAY_SECRET_FD names a decimal fd >= 3 (the connector's
//         spawn sets it to 3, 06 C-06.19): fstat it first — no such fd, or one
//         that is neither a FIFO nor a socket, is no secret and is never read.
//         Then read exactly 64 bytes (a short read keeps reading; EOF before 64
//         is no secret; EAGAIN on a non-blocking end is retried in 10 ms steps
//         for at most 2 s, then no secret — a daemon whose writer never writes
//         never hangs its boot), accept only 64 lowercase hex characters, and
//         close the fd. One exception to the close: an fd whose FIRST read fails
//         outright (ENXIO and its kin — on macOS the kqueue libuv opens at the
//         lowest free fd, which is 3 when nothing was handed there, presents to
//         fstat as a FIFO) was never handed to this process and is not ours to
//         close: closing it would end this process's event loop.
//       * else WEB_CHAT_RELAY_SECRET (the weaker channel C-03.22 names: an
//         environment block stays readable by same-user processes for the
//         daemon's life), under the same grammar.
//     Both variables are deleted from `env` whatever they held, so no child
//     ever meets them. A short, uppercase or non-hex value is no secret. Never
//     a file. `onTaken(via)` is told 'fd' or 'env' when a secret was taken (the
//     boot line names the channel, never the value). Never throws.
//
//   createRelayCredential({secret, redactor}) → { connected, valid(req), actorOf(req) }
//     connected — a secret was handed: 04 C-04.11's connected mode.
//     valid(req) — the request carries a valid relay credential (C-03.21):
//       its peer is loopback, it carries the portal's remote label
//       (lib/core/cors isRemoteRequest, === '1'), and it carries the relay
//       header (lib/core/writer-token RELAY_HEADER) exactly once, equal
//       (safeEqual) to the secret. A credential built with no secret answers
//       false for every request.
//     actorOf(req) — the actor, validated against schemas/03-actor-header.json
//       (hand-written below: no ajv at runtime), only beside a valid
//       credential and only from exactly one actor header (ACTOR_HEADER) of
//       printable ASCII, at most 512 bytes, that parses as JSON; else null.
//   The secret is registered with the redactor as 'relay-secret' at
//   construction (11 C-11.7), so no text the daemon keeps or answers shows it.
//   No route serves it and no accessor hands it out.
//
//   storedActor(actor) → the actor without `name` (C-03.23); actorName(actor)
//   → the name, or null (C-03.23a). For U743, which records and prints them.
//
// THE ACTOR IS ATTRIBUTION ONLY (C-15-3, C-03.21): nothing here, and nothing
// that reads actorOf, may change a writer, a level, a gate or a refusal on it.
// Neither the credential nor the actor changes the writer either: a relayed
// request stays {class: 'remote', owner: 'remote', verified: false}
// (lib/server/domain/writers.js), since `verified` is reserved for a
// daemon-local credential (C-15-2).

const nodeFs = require('fs');
const { isLoopbackAddress, isRemoteRequest } = require('../core/cors');
const { RELAY_HEADER, ACTOR_HEADER, safeEqual, soleHeader } = require('../core/writer-token');

const SECRET_FD_VAR = 'WEB_CHAT_RELAY_SECRET_FD';
const SECRET_ENV_VAR = 'WEB_CHAT_RELAY_SECRET';
const SECRET_BYTES = 64;
const SECRET_RE = /^[0-9a-f]{64}$/;
const FD_RE = /^[1-9][0-9]{0,6}$/;
const FIRST_FD = 3;
const EAGAIN_STEP_MS = 10;
const EAGAIN_MAX_MS = 2000;
const REDACT_LABEL = 'relay-secret';
const ACTOR_MAX_BYTES = 512;

// A synchronous pause: the intake runs before the event loop does anything.
function blockFor(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

const RETRY_CODES = new Set(['EAGAIN', 'EWOULDBLOCK']);

// Read the secret from `fd`. → the secret or null; closes the fd it read.
function readSecretFd(fd, fs, sleep) {
  let st;
  try { st = fs.fstatSync(fd); } catch { return null; }
  if (!st || !(st.isFIFO() || st.isSocket())) return null;
  const buf = Buffer.alloc(SECRET_BYTES);
  let got = 0;
  let waited = 0;
  let ours = true;
  while (got < SECRET_BYTES) {
    let n;
    try {
      n = fs.readSync(fd, buf, got, SECRET_BYTES - got, null);
    } catch (e) {
      const code = e && e.code;
      if (RETRY_CODES.has(code)) {
        if (waited >= EAGAIN_MAX_MS) break;
        sleep(EAGAIN_STEP_MS);
        waited += EAGAIN_STEP_MS;
        continue;
      }
      if (code === 'EINTR') continue;
      // Not a readable stream at all (see the header): never ours to close.
      if (got === 0 && waited === 0) ours = false;
      break;
    }
    if (!Number.isInteger(n) || n <= 0) break; // EOF before 64 bytes
    got += n;
  }
  if (ours) { try { fs.closeSync(fd); } catch {} }
  if (got !== SECRET_BYTES) return null;
  const text = buf.toString('latin1');
  buf.fill(0);
  return SECRET_RE.test(text) ? text : null;
}

function takeRelaySecret({ env = process.env, fs = nodeFs, sleep = blockFor, onTaken = null } = {}) {
  let fdText;
  let envText;
  try {
    fdText = env[SECRET_FD_VAR];
    envText = env[SECRET_ENV_VAR];
    delete env[SECRET_FD_VAR];
    delete env[SECRET_ENV_VAR];
  } catch {
    return null;
  }
  let secret = null;
  let via = null;
  if (typeof fdText === 'string' && FD_RE.test(fdText) && Number(fdText) >= FIRST_FD) {
    secret = readSecretFd(Number(fdText), fs, sleep);
    via = 'fd';
  } else if (typeof envText === 'string') {
    secret = SECRET_RE.test(envText) ? envText : null;
    via = 'env';
  }
  if (secret && typeof onTaken === 'function') { try { onTaken(via); } catch {} }
  return secret;
}

// ── the actor (schemas/03-actor-header.json, hand-written) ──────────────────

const ULID = '[0-9a-hjkmnp-tv-z]{26}';
const USER_RE = new RegExp(`^(usr_${ULID}|svc_${ULID}|svc_home)$`);
const CHAT_RE = new RegExp(`^cht_${ULID}$`);
const SESSION_RE = new RegExp(`^(srf|key|ses|agt)_${ULID}$`);
const AGENT_RE = /^agt_/;
const ACTIVITY_RE = new RegExp(`^act_${ULID}$`);
const NAME_RE = /^[A-Za-z0-9._'+-][A-Za-z0-9 ._'+-]{0,63}$/;
const VIA = new Set(['shell', 'phone', 'notification', 'api', 'mcp', 'scheduler']);
const ACTOR_KEYS = new Set(['v', 'user', 'chat', 'session', 'via', 'activity', 'name']);
const REQUIRED = ['v', 'user', 'session', 'via', 'activity'];
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isStr = (v, re) => typeof v === 'string' && re.test(v);

// Does `a` validate against schemas/03-actor-header.json? Every keyword of the
// locked schema, one line each; test/relay-credential.test.js holds this equal
// to ajv over the locked copy (test-support/contracts).
function isActor(a) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
  for (const k of Object.keys(a)) if (!ACTOR_KEYS.has(k)) return false;
  for (const k of REQUIRED) if (!has(a, k)) return false;
  if (a.v !== 1) return false;
  if (a.user !== null && !isStr(a.user, USER_RE)) return false;
  if (has(a, 'chat') && !isStr(a.chat, CHAT_RE)) return false;
  if (!isStr(a.session, SESSION_RE)) return false;
  if (typeof a.via !== 'string' || !VIA.has(a.via)) return false;
  if (!isStr(a.activity, ACTIVITY_RE)) return false;
  if (has(a, 'name') && !isStr(a.name, NAME_RE)) return false;
  if (AGENT_RE.test(a.session)) {
    // Another chat's agent: it names its chat, has no user and no name, via mcp.
    return has(a, 'chat') && a.user === null && a.via === 'mcp' && !has(a, 'name');
  }
  return !has(a, 'chat') && typeof a.user === 'string';
}

// The actor without its display name: what a daemon record may keep (C-03.23).
function storedActor(actor) {
  if (!isActor(actor)) return null;
  const out = {};
  for (const k of Object.keys(actor)) if (k !== 'name') out[k] = actor[k];
  return out;
}

// The display name, or null (C-03.23a: it rides as its own `by` field).
function actorName(actor) {
  return isActor(actor) && typeof actor.name === 'string' ? actor.name : null;
}

function createRelayCredential({ secret = null, redactor = null } = {}) {
  const held = typeof secret === 'string' && SECRET_RE.test(secret) ? secret : null;
  if (held && redactor && typeof redactor.addKnown === 'function') redactor.addKnown(held, REDACT_LABEL);

  function valid(req) {
    if (!held || !req) return false;
    try {
      const peer = req.socket ? req.socket.remoteAddress : undefined;
      if (!isLoopbackAddress(peer) || !isRemoteRequest(req)) return false;
      const value = soleHeader(req, RELAY_HEADER);
      return typeof value === 'string' && safeEqual(value, held);
    } catch {
      return false;
    }
  }

  function actorOf(req) {
    if (!valid(req)) return null;
    const raw = soleHeader(req, ACTOR_HEADER);
    if (typeof raw !== 'string' || raw.length > ACTOR_MAX_BYTES || !PRINTABLE_ASCII_RE.test(raw)) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    return isActor(parsed) ? parsed : null;
  }

  return Object.freeze({ connected: !!held, valid, actorOf });
}

module.exports = {
  takeRelaySecret,
  createRelayCredential,
  storedActor,
  actorName,
  isActor,
  SECRET_FD_VAR,
  SECRET_ENV_VAR,
  EAGAIN_STEP_MS,
  EAGAIN_MAX_MS,
  ACTOR_MAX_BYTES,
};

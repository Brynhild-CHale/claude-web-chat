'use strict';

// The relay over the link and the connector's gate (contract 05 §3.8 C-05.28 to
// C-05.36, with A-05.3's C-05.31 sentence; 06 C-06.4 steps 3, 4, 6 and 7,
// C-06.27, C-06.28, C-06.30 and C-06.31/C-06.33 as A-06.2 replaces them; 04
// C-04.9, C-04.12, C-04.13, C-04.18, C-04.20, C-04.27; 11 C-11.2 to C-11.5;
// tranche 6, U717).
//
//   createRelay({ link, targetOf, record, connected, hintFor, log, onUnconfirmed,
//                 answersFor, answerPorts, now }) → relay (an EventEmitter)
//   install(ctx) → createRelay(ctx)   (CONNECTOR@install-seam: U790 wires it)
//
// The relay hears the hub's relay.* frames through link.channel('relay', …)
// and answers each relay.http.request and relay.ws.open from one daemon on
// loopback. It emits 'deny' (one event per refusal or dropped message; U730
// subscribes) and offers relay.request(…), the one-shot relayed request the
// connector itself originates (U717-U728@one-shot-relayed-request (a)).
//
// THE CTX. `targetOf(label)` → { running, root, instance, rec: {pid, port},
// origins: {surface, answer, shell}, secret } — the supervisor's view of a
// chat (secret null for a daemon this connector did not spawn, or after a
// restart). `record()` → the connector record (06-connector-state.json: its
// machine.id and its top-level ceiling, read by lib/core/connected-ceiling
// ceilingOf, absent = full). `connected` defaults to lib/core/connected-policy
// (a test may substitute it). `hintFor(need, {connected, destructive})` is
// U745's one signature over the hub's words (06 C-06.34a); it has no default,
// because no default would be in the hub's words and remote-policy's own hints
// name host commands (C-04.20 forbids them). `onUnconfirmed(label)` hears an
// identity that did not answer (the supervisor's to act on).
//
// THE GATE, per relay.http.request, relay.ws.open and relay.request, in this
// order, each step failing closed:
//   (1) TARGET — the chat assigned and running here, else 404 with the
//       connector's own body {ok:false, connector:true, reason:'not-running'}
//       (C-05.30). The hub never names a path or a registry id (C-05.49).
//   (2) DECISION — the frame's full decision, or a decision_ref to one this
//       link received in relay.decision (A-05.3: kept per link in memory and
//       ALL dropped when the link closes, never compared across links). None,
//       a shape that fails, another machine or another chat → 'no-decision';
//       a version below one held for its (principal, chat) → 'no-decision';
//       expires_at passed → 'expired'.
//   (3) SHAPE — an upgrade only to /ws on the surface origin; an HTTP request
//       only on the session or answer origin with one of 05's methods.
//   (4) THE CONNECTED TABLE (C-04.13, C-04.20) — classifySession or
//       classifyAnswerRoute by origin, method and raw target; host_only and
//       retired rows always refused (C-06.27's harness rows and its extra
//       list), a route with no row the default deny ('unknown'); else the row's
//       level held ('status' held as specifics.status), every requires flag
//       true, its refuse_query unmatched, and the level under the machine's
//       ceiling ('ceiling').
//   (5) THE DAEMON'S OWN POLICY AT THE HUB'S LEVEL (C-06.27's first sentence,
//       C-11.5) — remote-policy classify (surface) or classifyAnswer (answer)
//       at decision.daemon_level, allowDestructive = specifics.destructive; any
//       refusal is refused here too.
//   (6) IDENTITY (C-05.30) — lib/relay's ONE engine (createIdentityCheck) with
//       lib/util/registry answersFor(rec, instance, {strictInstance: true}) as
//       its predicate, memoised 1 s for HTTP and asked fresh for every upgrade;
//       not ok → 502 with lib/relay NOT_ANSWERING, and onUnconfirmed(label).
// A refusal at (2) to (5) is 403 with 04's refusal body (04-refusal-body.json),
// on an upgrade as relay.ws.refused {status: 403, body}.
//
// UPSTREAM (C-05.30, C-06.30, 06-relay-headers.json upstream_request). The
// stamp is built here and nowhere else, from the header-name constants of its
// owners: the relay credential pair from lib/core/writer-token (RELAY_HEADER,
// the secret handed to that daemon at spawn; ACTOR_HEADER, the frame's actor as
// one line of compact ASCII JSON — both ABSENT when targetOf's secret is null),
// then lib/core/cors LEVEL_HEADER (decision.daemon_level), GRANTS_HEADER (the
// held levels and true specifics, in 04's order) and DECISION_HEADER. lib/relay
// forwardHeaders rebuilds the rest (its allowlist, sec-fetch-*, the answer
// nonce toward the answer surface only, Origin rewritten only when the hub
// forwarded one) and sets X-WC-Remote last, so a viewer can neither send nor
// suppress any of them. The connector never reads a cookie or an Authorization
// header (C-06.4 step 2) and never opens a daemon request or socket on the
// hub's behalf without the remote marker (C-11.2).
//
// HTTP (C-05.32, C-05.33). lib/relay proxyHttp, unchanged, driven through a
// duck-typed req (a PassThrough fed by the request's inline body and its
// relay.http.body frames, credit granted back as it drains) and res (a
// Writable whose writeHead/flushHeaders send relay.http.response and whose
// writes go out as relay.http.body frames of at most 256 KiB decoded, each
// waiting for send credit, so up.pipe(res) pauses the daemon's response —
// RELAY@duck-sink). The response bytes pass untouched (C-11.3); a daemon 403
// is classified for the deny event from at most the first 64 KiB it relays.
//
// WEBSOCKET (C-05.34 to C-05.36, C-04.12, C-04.18). The gate (identity fresh),
// a stream slot (past the caps 429), then lib/relay openUpstream. Daemon to
// hub: relay.ws.data fragments of at most 256 KiB decoded, text cut only at
// code point boundaries, all but the last more: true, the upstream paused while
// the stream has no send credit. Hub to daemon: fragments reassembled, then THE
// INBOUND FILTER — a binary, unparseable or over-1-MiB message, or one whose
// `type` has no ws_inbound level or a level the decision does not hold (or
// above the ceiling) is dropped and told as 'deny'. Closes pass through, 1005
// sent as 1000 and 1006 as 1011 (U717@ws-close-code-map (a)). A newer decision
// version for an open relay's (principal, chat) that changes daemon_level,
// levels or specifics closes that relay with 4403 at once, and aborts its
// in-flight HTTP requests (access_changed).
//
// NEVER: a CSRF or Origin compare against a hub origin (the hub's, C-06.4 step
// 5); body rewriting, filtering or redaction (C-11.3); a host read through the
// relay (C-06.28); a local or host meaning given to anything (the daemon
// decides relayed, U742); an apex, picker or session start (those have no row);
// a secret in a frame, a log line or an error (C-05.50). Log lines carry codes
// and counts only.

const { EventEmitter } = require('events');
const { PassThrough, Readable, Writable } = require('stream');
const relayLib = require('../relay');
const registry = require('../util/registry');
const { instanceId } = require('../core/portfiles');
const remotePolicy = require('../core/remote-policy');
const defaultConnected = require('../core/connected-policy');
const { ceilingOf } = require('../core/connected-ceiling');
const { stableKey } = require('../core/stable-json');
const { RELAY_HEADER, ACTOR_HEADER } = require('../core/writer-token');
const { LEVEL_HEADER, GRANTS_HEADER, DECISION_HEADER } = require('../core/cors');
const { FRAME_MAX } = require('./frames');

const {
  proxyHttp, NOT_ANSWERING, createAnswerPorts, createIdentityCheck, openUpstream,
  securityHeaders, answerSecurityHeaders, embedHeaders, isHealthRead, pathnameOf,
} = relayLib;

// ── constants ───────────────────────────────────────────────────────────────
const CHUNK = 256 * 1024;                 // C-05.23: decoded bytes per body / data frame
const INBOUND_MAX = 1024 * 1024;          // C-04.18: a reassembled viewer message
const IDENTITY_MEMO_MS = 1000;            // C-05.30: memoised 1 s for HTTP
const REFUSAL_PEEK = 64 * 1024;           // a daemon 403 body read for the deny event
const CLOSE_REASON_MAX = 123;             // a close frame's reason, in bytes
const CLOSE_WITHIN_MS = 1000;             // C-05.36, C-04.12: the upstream closed within 1 s
const SINK_HWM = 64 * 1024;               // the duck req's and res's buffers
const DECISIONS_MAX = 4096;               // decisions kept per link (a bound on memory, never a rule)
const PATH_MAX = 512;                     // 04-deny-record.json path

// The stamp's header names, lowercased (lib/relay checkStamp takes lowercase
// x-wc-* keys). Each is its owner's constant; none is spelled here.
const STAMP_NAMES = Object.freeze({
  relay: RELAY_HEADER.toLowerCase(),
  actor: ACTOR_HEADER.toLowerCase(),
  level: LEVEL_HEADER.toLowerCase(),
  grants: GRANTS_HEADER.toLowerCase(),
  decision: DECISION_HEADER.toLowerCase(),
});

// The one response header this module adds that lib/relay does not build:
// 04's answer origin, on a relayed health read at the surface (C-04.9).
const ANSWER_ORIGIN_HEADER = 'x-wc-answer-origin';

const NOT_RUNNING = Object.freeze({ ok: false, connector: true, reason: 'not-running' });
// The two non-policy refusals a relay.ws.refused body may carry are 04's
// refusal body or {ok, remote, error} (05-relay-ws.json refused.body).
const BUSY = Object.freeze({ ok: false, remote: true, error: 'too many relayed streams are open on this machine' });
const NOT_RUNNING_WS = Object.freeze({ ok: false, remote: true, error: 'this chat is not running on this machine' });

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SURFACES = new Set(['session', 'answer']);
const DAEMON_LEVELS = Object.freeze(['basic', 'read', 'full']);
const DESIGN_LEVELS = new Set(['read', 'message', 'write_page', 'files']);
const GRANT_ORDER = Object.freeze(['status', 'read', 'message', 'write_page', 'files', 'steer', 'destructive']);
// A table level → the daemon level it lives at (C-04.4), for the ceiling.
const TABLE_TO_DAEMON = Object.freeze({ status: 'basic', read: 'read', message: 'full', write_page: 'full', files: 'full' });
const DECISION_ID_RE = /^dec_[0-9a-hjkmnp-tv-z]{26}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
const ACTOR_MAX = 512;

// remote-policy's verdict reason → 04's deny reason (step 5).
const POLICY_REASON = Object.freeze({
  refused: 'host-only', mirror: 'level', destructive: 'requires', query: 'query', unknown: 'unknown', malformed: 'malformed',
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const rank = (daemonLevel) => DAEMON_LEVELS.indexOf(daemonLevel);

// ── decisions ───────────────────────────────────────────────────────────────

// The fields this module reads, checked (05's frame table checks the top level
// only; a nested body is its consumer's, failing closed).
function decisionOk(d) {
  if (!isPlainObject(d)) return false;
  if (typeof d.decision_id !== 'string' || !DECISION_ID_RE.test(d.decision_id)) return false;
  if (!Number.isInteger(d.version) || d.version < 1) return false;
  if (typeof d.expires_at !== 'string' || !Number.isFinite(Date.parse(d.expires_at))) return false;
  if (!isPlainObject(d.principal)) return false;
  if (typeof d.chat_id !== 'string' || typeof d.machine_id !== 'string') return false;
  if (!Array.isArray(d.levels) || !d.levels.every((l) => DESIGN_LEVELS.has(l))) return false;
  if (new Set(d.levels).size !== d.levels.length) return false;
  const s = d.specifics;
  if (!isPlainObject(s) || ['status', 'steer', 'destructive'].some((k) => typeof s[k] !== 'boolean')) return false;
  if (!DAEMON_LEVELS.includes(d.daemon_level)) return false;
  if (!isPlainObject(d.origins) || !(d.origins.answer === null || typeof d.origins.answer === 'string')) return false;
  return true;
}

// What C-04.12 compares: a new version closes a relay only when one of these differs.
function materialOf(d) {
  return stableKey({ daemon_level: d.daemon_level, levels: [...d.levels].sort(), specifics: d.specifics });
}

// Does the decision hold a table level? ('status' is specifics.status, C-04.20.)
function holds(d, level) {
  if (level === 'status') return d.specifics.status === true;
  return DESIGN_LEVELS.has(level) && d.levels.includes(level);
}

// The ceiling admits a table level when the level's daemon level is at or
// below it: 'read' admits status and read rows; 'basic' status rows only.
function underCeiling(level, ceiling) {
  const dl = TABLE_TO_DAEMON[level];
  return dl != null && rank(ceiling) >= 0 && rank(dl) <= rank(ceiling);
}

// 04's grants: held levels and true specifics, in the schema's order.
function grantsOf(d) {
  return GRANT_ORDER.filter((g) => {
    if (g === 'status' || g === 'steer' || g === 'destructive') return d.specifics[g] === true;
    return d.levels.includes(g);
  }).join(',');
}

// The frame's actor as one line of compact ASCII JSON (03-actor-header.json):
// JSON.stringify, every character past printable ASCII escaped. Null for no
// object, or one past 512 bytes (attribution only: it gates nothing, C-15-1).
function actorLine(actor) {
  if (!isPlainObject(actor)) return null;
  let s;
  try { s = JSON.stringify(actor); } catch { return null; }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return s.length <= ACTOR_MAX ? s : null;
}

// The upstream stamp (C-05.30's order): the relay credential pair only beside a
// secret, then the level, the grants and the decision. X-WC-Remote is
// forwardHeaders' / openUpstream's, set after these.
function stampOf(target, d, actor) {
  const s = {};
  const secret = typeof target.secret === 'string' && SECRET_RE.test(target.secret) ? target.secret : null;
  if (secret) {
    s[STAMP_NAMES.relay] = secret;
    const a = actorLine(actor);
    if (a) s[STAMP_NAMES.actor] = a;
  }
  s[STAMP_NAMES.level] = d.daemon_level;
  const g = grantsOf(d);
  if (g) s[STAMP_NAMES.grants] = g;
  s[STAMP_NAMES.decision] = d.decision_id;
  return s;
}

// ── small helpers ───────────────────────────────────────────────────────────
const b64 = (buf) => Buffer.from(buf).toString('base64');
const jsonBytes = (v) => Buffer.from(JSON.stringify(v));
const pathOf = (p) => pathnameOf(typeof p === 'string' ? p : '/').slice(0, PATH_MAX);

function hasHeader(headers, name) {
  if (!isPlainObject(headers)) return false;
  return Object.keys(headers).some((k) => k.toLowerCase() === name && headers[k] != null);
}

// A close code a relay.ws.close may carry: 1005 and 1006 are codes no close
// frame may carry (U717@ws-close-code-map (a)); anything outside 1000–4999 is
// an internal error.
function mapCloseCode(code) {
  if (code === 1005) return 1000;
  if (code === 1006) return 1011;
  return Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1011;
}

// A close reason cut at 123 bytes on a code point boundary.
function cutReason(reason) {
  const buf = Buffer.isBuffer(reason) ? reason : Buffer.from(String(reason || ''), 'utf8');
  let end = Math.min(buf.length, CLOSE_REASON_MAX);
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

// The next fragment of a message from `offset`: at most 256 KiB decoded, cut at
// a UTF-8 boundary for text, and small enough that its frame stays under
// C-05.10's 1 MiB once JSON-escaped.
function pieceOf(buf, offset, binary) {
  if (buf.length === 0) return { data: '', n: 0, end: 0 };
  let end = Math.min(buf.length, offset + CHUNK);
  for (;;) {
    if (!binary) while (end > offset && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
    if (end <= offset) end = Math.min(buf.length, offset + 4); // a single code point always fits
    const slice = buf.subarray(offset, end);
    const data = binary ? slice.toString('base64') : slice.toString('utf8');
    if (Buffer.byteLength(JSON.stringify(data)) + 512 <= FRAME_MAX || end - offset <= 4) return { data, n: slice.length, end };
    end = offset + Math.floor((end - offset) / 2);
  }
}

// Response headers as 05's frame carries them: lowercase names, string or
// string-array values.
function frameHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

// ── the sinks proxyHttp writes into (RELAY@duck-sink) ───────────────────────
// writeHead, flushHeaders, headersSent, write/end, destroy and 'close', as
// lib/relay http.js documents its sink. A 403 keeps the first 64 KiB of what it
// relays (never altered) for the deny event.
class RelaySink extends Writable {
  constructor(hooks) {
    super({ highWaterMark: SINK_HWM });
    this.hooks = hooks;
    this.statusCode = null;
    this.headers = null;
    this.headersSent = false;
    this.peek = [];
    this.peeked = 0;
    this.finishedOk = false;
    this.quiet = false;
    this.on('error', () => {});
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers || {};
    this.headersSent = true;
    return this;
  }
  flushHeaders() { this.hooks.head(this); }
  _write(chunk, _enc, cb) {
    if (this.statusCode === 403 && this.peeked < REFUSAL_PEEK) {
      const take = chunk.subarray(0, REFUSAL_PEEK - this.peeked);
      this.peek.push(take);
      this.peeked += take.length;
    }
    Promise.resolve().then(() => this.hooks.body(this, chunk)).then(() => cb(), (e) => cb(e));
  }
  _final(cb) {
    Promise.resolve().then(() => this.hooks.end(this)).then(() => { this.finishedOk = true; cb(); }, (e) => cb(e));
  }
  _destroy(err, cb) {
    if (!this.finishedOk && !this.quiet) {
      try { this.hooks.abort(this); } catch { /* the stream is gone */ }
    }
    cb(err);
  }
  // proxyHttp registers its 'close' listener (which destroys the daemon's
  // response) after writeHead: a sink the hub already ended still tells it.
  on(event, fn) {
    if (event === 'close' && this.closed) { process.nextTick(fn); return this; }
    return super.on(event, fn);
  }
  // The hub ended the stream: tear down without telling it.
  quietDestroy() {
    this.quiet = true;
    this.destroy();
  }
  peekBody() { return Buffer.concat(this.peek, this.peeked); }
}

// ── the relay ───────────────────────────────────────────────────────────────
function createRelay({
  link, targetOf, record, connected = defaultConnected, hintFor, log = () => {}, onUnconfirmed = () => {},
  answersFor = registry.answersFor, answerPorts = createAnswerPorts(), now = Date.now,
} = {}) {
  if (!link || typeof link.channel !== 'function' || typeof link.send !== 'function' || !link.streams) {
    throw new TypeError('createRelay: link (U716) is required');
  }
  if (typeof targetOf !== 'function') throw new TypeError('createRelay: targetOf(label) is required');
  if (typeof record !== 'function') throw new TypeError('createRelay: record() is required');
  if (typeof hintFor !== 'function') throw new TypeError('createRelay: hintFor(need, {connected, destructive}) is required (the hub\'s words, U745)');
  for (const k of ['classifySession', 'classifyAnswerRoute', 'wsInboundLevel']) {
    if (!connected || typeof connected[k] !== 'function') throw new TypeError(`createRelay: connected.${k} is required`);
  }

  const relay = new EventEmitter();
  const say = (line) => { try { log(line); } catch { /* the caller's */ } };

  // Decisions held on THIS link (A-05.3): dropped whole at every link close.
  let held = new Map();       // `${decision_id}\0${version}` → decision
  let versions = new Map();   // `${principal}\0${chat}` → the highest version seen
  const relays = new Map();   // stream → an open relay (http or ws)
  const opening = new Map();  // stream → a ws relay still in its gate

  // ── identity (step 6) ────────────────────────────────────────────────────
  const identity = createIdentityCheck({
    memoMs: IDENTITY_MEMO_MS,
    now,
    probe: async (t) => {
      try {
        return (await answersFor(t.rec, t.instance, { strictInstance: true })) ? 'ok' : 'mismatch';
      } catch {
        return 'mismatch';
      }
    },
  });
  function idTarget(label, target) {
    const instance = typeof target.instance === 'string' && target.instance
      ? target.instance
      : (typeof target.root === 'string' && target.root ? instanceId(target.root) : null);
    return { id: label, port: target.rec.port, pid: target.rec.pid, rec: target.rec, instance };
  }

  function safeTarget(label) {
    let t = null;
    try { t = targetOf(label); } catch { t = null; }
    if (!t || t.running !== true || !isPlainObject(t.rec) || !Number.isInteger(t.rec.port) || !Number.isInteger(t.rec.pid)) return null;
    return t;
  }

  function thisMachine() {
    let r = null;
    try { r = record(); } catch { r = null; }
    if (!isPlainObject(r)) return { machineId: null, ceiling: 'basic' };
    const machineId = typeof r.machine_id === 'string' ? r.machine_id
      : (isPlainObject(r.machine) && typeof r.machine.id === 'string' ? r.machine.id : null);
    return { machineId, ceiling: ceilingOf({ ok: true, value: r }) };
  }

  const principalKey = (d) => stableKey(d.principal);
  const versionKey = (d) => `${principalKey(d)}\0${d.chat_id}`;

  // A decision this link received: note its version; a newer one whose
  // material differs closes the open relays judged with an older one (C-04.12).
  function noteDecision(d) {
    const key = versionKey(d);
    const prev = versions.get(key) || 0;
    if (d.version <= prev) return;
    versions.set(key, d.version);
    if (versions.size > DECISIONS_MAX) versions.delete(versions.keys().next().value);
    const pk = principalKey(d);
    const m = materialOf(d);
    for (const st of [...relays.values()]) {
      if (st.chat !== d.chat_id || st.pk !== pk || st.decision.version >= d.version) continue;
      if (materialOf(st.decision) === m) continue;
      accessChanged(st);
    }
  }

  function accessChanged(st) {
    say(`relay stream ${st.stream} access changed`);
    if (st.kind === 'ws') {
      endWs(st, { code: 4403, upstreamCode: 4403 });
      return;
    }
    st.aborted = true;
    relays.delete(st.stream);
    link.send('relay', 'relay.http.abort', { stream: st.stream, reason: 'access_changed' });
    if (st.res) st.res.quietDestroy();
    st.req.destroy();
    link.streams.close(st.stream);
  }

  function onDecisionFrame(f) {
    const d = f.decision;
    if (!decisionOk(d) || d.chat_id !== f.chat) { say('relay decision refused shape'); return; }
    if (d.machine_id !== thisMachine().machineId) { say('relay decision refused machine'); return; }
    held.set(`${d.decision_id}\0${d.version}`, d);
    if (held.size > DECISIONS_MAX) held.delete(held.keys().next().value);
    noteDecision(d);
  }

  // ── the gate ─────────────────────────────────────────────────────────────
  function hintText(need, reason) {
    let h = null;
    try { h = hintFor(need, { connected: true, destructive: reason === 'requires' }); } catch { h = null; }
    if (typeof h !== 'string' || !h) h = 'This is not allowed through the hub.';
    return h.slice(0, 300);
  }

  // One refusal: 04's body and the deny event's fields.
  function refusal(q, { reason, need = null, rule = null, requires = null, decision = null, current = false }) {
    const authority = { reason, need, ...(requires && requires.length ? { requires } : {}), rule, decision_id: current && decision ? decision.decision_id : null };
    const body = {
      ok: false, remote: true, hint: hintText(need, reason),
      ...(reason === 'level' && decision ? { mirror: decision.daemon_level } : {}),
      authority,
    };
    const deny = {
      enforcer: 'connector',
      origin: q.upgrade ? 'session' : (SURFACES.has(q.surface) ? q.surface : 'session'),
      method: q.upgrade ? 'WS' : String(q.method || '').toUpperCase().slice(0, 16),
      path: pathOf(q.path),
      rule, need, reason, status: 403,
      principal: decision ? decision.principal : null,
      chat_id: q.chat,
      machine_id: q.machineId,
      decision_id: authority.decision_id,
    };
    return { ok: false, status: 403, body, deny };
  }

  function decisionFor(q) {
    let d = null;
    if (q.decision != null) d = q.decision;
    else if (isPlainObject(q.decision_ref)) d = held.get(`${q.decision_ref.decision_id}\0${q.decision_ref.version}`) || null;
    if (!decisionOk(d)) return { reason: 'no-decision', decision: null };
    if (d.machine_id !== q.machineId || d.chat_id !== q.chat) return { reason: 'no-decision', decision: d };
    if (q.decision != null) noteDecision(d);
    if (d.version < (versions.get(versionKey(d)) || 0)) return { reason: 'no-decision', decision: d };
    if (Date.parse(d.expires_at) <= now()) return { reason: 'expired', decision: d };
    return { reason: null, decision: d };
  }

  // q: {chat, surface, method, path, decision, decision_ref, actor, upgrade}
  // → {ok: true, target, decision, row, stamp} | {ok: false, status, body, deny?}
  async function gate(q) {
    // (1) target
    const target = safeTarget(q.chat);
    if (!target) return { ok: false, status: 404, body: q.upgrade ? NOT_RUNNING_WS : NOT_RUNNING };
    const { machineId, ceiling } = thisMachine();
    q.machineId = machineId;
    // (2) decision
    const dv = decisionFor(q);
    if (dv.reason) return refusal(q, { reason: dv.reason, decision: dv.decision });
    const d = dv.decision;
    const cur = { decision: d, current: true };
    // (3) shape
    if (q.upgrade) {
      if (q.path !== '/ws' || q.surface !== 'session') return refusal(q, { reason: 'unknown', ...cur });
    } else if (!SURFACES.has(q.surface) || !METHODS.has(q.method)) {
      return refusal(q, { reason: 'malformed', ...cur });
    }
    const method = q.upgrade ? 'GET' : q.method;
    const answer = q.surface === 'answer';
    // (4) the connected table
    const v = answer ? connected.classifyAnswerRoute(method, q.path) : connected.classifySession(method, q.path);
    const row = v && v.row;
    if (!v || !v.allow || !row) {
      let reason = v && ['query', 'unknown', 'malformed'].includes(v.reason) ? v.reason : 'unknown';
      if (v && v.reason === 'refused') reason = row && row.level === 'retired' ? 'retired' : 'host-only';
      return refusal(q, { reason, need: row ? row.level : null, rule: v ? v.key : null, ...cur });
    }
    const need = row.level;
    if (!holds(d, need)) return refusal(q, { reason: 'level', need, rule: v.key, ...cur });
    const missing = (row.requires || []).filter((flag) => d.specifics[flag] !== true);
    if (missing.length) return refusal(q, { reason: 'requires', need, rule: v.key, requires: missing, ...cur });
    if (!underCeiling(need, ceiling)) return refusal(q, { reason: 'ceiling', need, rule: v.key, ...cur });
    // (5) the daemon's own policy at the hub's level
    const opts = { mirror: d.daemon_level, allowDestructive: d.specifics.destructive === true };
    const pv = answer ? remotePolicy.classifyAnswer(method, q.path, opts) : remotePolicy.classify(method, q.path, opts);
    if (!pv.allow) {
      return refusal(q, {
        reason: POLICY_REASON[pv.reason] || 'unknown', need, rule: pv.key,
        requires: pv.reason === 'destructive' ? ['destructive'] : null, ...cur,
      });
    }
    // (6) identity, memoised for HTTP, fresh for every upgrade
    const answerOk = await identity.confirm(idTarget(q.chat, target), { fresh: !!q.upgrade });
    if (answerOk !== 'ok') {
      say(`relay identity ${answerOk}`);
      try { onUnconfirmed(q.chat); } catch { /* the supervisor's */ }
      return { ok: false, status: 502, body: NOT_ANSWERING };
    }
    // A newer decision may have arrived while the probe ran.
    if (d.version < (versions.get(versionKey(d)) || 0)) return refusal(q, { reason: 'no-decision', decision: d });
    return { ok: true, target, decision: d, row, rule: v.key, stamp: stampOf(target, d, q.actor) };
  }

  function emitDeny(deny) {
    if (deny) relay.emit('deny', deny);
  }

  // A daemon 403, read for the deny event (C-04.21, C-04.27): second-lock when
  // the body carries mirror or is the answer engine's refusal, else daemon-rule.
  function daemonDeny(q, g, bodyBytes) {
    let parsed = null;
    try { parsed = JSON.parse(bodyBytes.toString('utf8')); } catch { parsed = null; }
    const answer = q.surface === 'answer';
    const second = isPlainObject(parsed) && (
      Object.prototype.hasOwnProperty.call(parsed, 'mirror')
      || (answer && parsed.ok === false && parsed.remote === true && typeof parsed.error === 'string'));
    emitDeny({
      enforcer: 'daemon',
      origin: q.upgrade ? 'session' : q.surface,
      method: q.upgrade ? 'WS' : q.method,
      path: pathOf(q.path),
      rule: g.rule, need: g.row.level, reason: second ? 'second-lock' : 'daemon-rule', status: 403,
      principal: g.decision.principal, chat_id: q.chat, machine_id: q.machineId, decision_id: g.decision.decision_id,
    });
  }

  // ── proxying one HTTP request (the link's and relay.request's) ───────────
  function refusalHeaders(q) {
    const sec = q.surface === 'answer' ? answerSecurityHeaders() : securityHeaders(pathnameOf(q.path), { embedded: true });
    return { 'content-type': 'application/json', ...sec };
  }

  async function proxyWith(q, g, req, res) {
    const t = g.target;
    const ancestors = { shell: t.origins && t.origins.shell, surface: t.origins && t.origins.surface };
    const session = { id: q.chat, port: t.rec.port, pid: t.rec.pid };
    const answer = q.surface === 'answer';
    let port = t.rec.port;
    if (answer) {
      port = await answerPorts.portOf(session);
      if (!port) {
        res.writeHead(502, { 'content-type': 'application/json', ...answerSecurityHeaders() });
        res.end(JSON.stringify(NOT_ANSWERING));
        return;
      }
    }
    let extraHeaders = null;
    if (!answer && isHealthRead(q.method, pathnameOf(q.path))) {
      extraHeaders = embedHeaders({ shell: ancestors.shell });
      if (typeof g.decision.origins.answer === 'string') extraHeaders[ANSWER_ORIGIN_HEADER] = g.decision.origins.answer;
    }
    const retry = answer
      ? async () => { answerPorts.forget(session); return answerPorts.portOf(session); }
      : async () => {
        const t2 = safeTarget(q.chat);
        if (!t2 || t2.secret !== t.secret) return null;
        return (await identity.confirm(idTarget(q.chat, t2), { fresh: true })) === 'ok' ? t2.rec.port : null;
      };
    await proxyHttp(req, res, {
      port,
      origin: hasHeader(q.headers, 'origin'),
      mode: answer ? 'answer' : 'session',
      stamp: g.stamp,
      ancestors,
      extraHeaders,
      retry,
      onUpstreamError: () => { identity.clear(); if (answer) answerPorts.forget(session); },
    });
  }

  // proxyWith, with a programming error (a malformed stamp or origin) logged
  // and answered as a daemon that is not answering, never thrown at the link.
  async function proxySafely(q, g, req, res) {
    try {
      await proxyWith(q, g, req, res);
    } catch (e) {
      say(`relay proxy error ${e && e.name ? e.name : 'Error'}`);
      if (!res.headersSent) {
        res.writeHead(502, refusalHeaders(q));
        res.end(JSON.stringify(NOT_ANSWERING));
      } else {
        res.destroy();
      }
    }
  }

  // ── relay.http.request ───────────────────────────────────────────────────
  function grant(stream, n) {
    if (n > 0 && link.streams.has(stream)) link.streams.grant(stream, n);
  }

  function feed(st, b64body, end) {
    if (st.aborted || st.req.destroyed) return;
    const buf = b64body ? Buffer.from(b64body, 'base64') : Buffer.alloc(0);
    if (buf.length) {
      if (st.req.write(buf)) {
        grant(st.stream, buf.length);
      } else {
        st.owed += buf.length;
        if (!st.drainArmed) {
          st.drainArmed = true;
          st.req.once('drain', () => {
            st.drainArmed = false;
            const n = st.owed;
            st.owed = 0;
            grant(st.stream, n);
          });
        }
      }
    }
    if (end) st.req.end();
  }

  // A whole response from the connector itself (404, 403, 429, 502): one frame.
  async function answerWhole(f, status, headers, bodyBuf, { streamOpen = true } = {}) {
    if (streamOpen) {
      try { await link.streams.sendCredit(f.stream, bodyBuf.length); } catch { return; }
    }
    link.send('relay', 'relay.http.response', {
      stream: f.stream, status, headers: frameHeaders(headers), body: b64(bodyBuf), end: true,
    }, { re: f.id });
    if (streamOpen) link.streams.close(f.stream);
  }

  function linkSinkHooks(st, f) {
    let headSent = false;
    const head = (sink) => {
      if (headSent || st.aborted) return;
      headSent = true;
      const id = link.send('relay', 'relay.http.response', {
        stream: st.stream, status: sink.statusCode, headers: frameHeaders(sink.headers), end: false,
      }, { re: f.id });
      if (id == null) throw Object.assign(new Error('the link is down'), { code: 'ELINKDOWN' });
    };
    return {
      head,
      async body(sink, chunk) {
        head(sink);
        for (let off = 0; off < chunk.length; off += CHUNK) {
          const piece = chunk.subarray(off, Math.min(chunk.length, off + CHUNK));
          await link.streams.sendCredit(st.stream, piece.length);
          if (link.send('relay', 'relay.http.body', { stream: st.stream, body: b64(piece), end: false }) == null) {
            throw Object.assign(new Error('the link is down'), { code: 'ELINKDOWN' });
          }
        }
      },
      async end(sink) {
        if (!headSent) {
          headSent = true;
          link.send('relay', 'relay.http.response', {
            stream: st.stream, status: sink.statusCode, headers: frameHeaders(sink.headers), end: true,
          }, { re: f.id });
        } else {
          link.send('relay', 'relay.http.body', { stream: st.stream, body: '', end: true });
        }
        relays.delete(st.stream);
        link.streams.close(st.stream);
        if (sink.statusCode === 403) daemonDeny(st.q, st.g, sink.peekBody());
      },
      abort() {
        relays.delete(st.stream);
        if (link.streams.has(st.stream)) {
          link.send('relay', 'relay.http.abort', { stream: st.stream, reason: 'upstream_error' });
          link.streams.close(st.stream);
        }
      },
    };
  }

  async function onHttpRequest(f) {
    const slot = link.streams.open(f.stream, f.chat, { kind: 'http', onEnd: (why) => onStreamEnd(f.stream, why) });
    if (!slot.ok) {
      say(`relay stream refused ${slot.reason}`);
      if (slot.reason === 'link_full' || slot.reason === 'chat_full') {
        await answerWhole(f, 429, refusalHeaders(f), jsonBytes(BUSY), { streamOpen: false });
      }
      return;
    }
    const req = new PassThrough({ highWaterMark: SINK_HWM });
    req.on('error', () => {});
    req.method = f.method;
    req.url = f.path;
    req.headers = isPlainObject(f.headers) ? f.headers : {};
    const st = {
      kind: 'http', stream: f.stream, chat: f.chat, req, res: null, aborted: false,
      owed: 0, drainArmed: false, decision: null, pk: null, q: null, g: null,
    };
    relays.set(f.stream, st);
    if (f.body) link.streams.receive(f.stream, Buffer.byteLength(f.body, 'base64'));
    feed(st, f.body, f.end);

    const q = {
      chat: f.chat, surface: f.surface, method: f.method, path: f.path, headers: req.headers,
      decision: f.decision, decision_ref: f.decision_ref, actor: f.actor, upgrade: false,
    };
    const g = await gate(q);
    if (st.aborted) return;
    if (!g.ok) {
      relays.delete(f.stream);
      req.destroy();
      emitDeny(g.deny);
      say(`relay refused ${g.status}${g.deny ? ` ${g.deny.reason}` : ''}`);
      await answerWhole(f, g.status, refusalHeaders(q), jsonBytes(g.body));
      return;
    }
    st.q = q;
    st.g = g;
    st.decision = g.decision;
    st.pk = principalKey(g.decision);
    st.res = new RelaySink(linkSinkHooks(st, f));
    await proxySafely(q, g, req, st.res);
  }

  function onHttpBody(f) {
    const st = relays.get(f.stream);
    if (!st || st.kind !== 'http') return;
    feed(st, f.body, f.end);
  }

  // The link ended a stream: the hub's abort or close, a link close, or a
  // window_exceeded. Our own close ('closed') has already been handled.
  function onStreamEnd(stream, why) {
    const st = relays.get(stream);
    if (!st || why === 'closed') return;
    relays.delete(stream);
    if (st.kind === 'http') {
      st.aborted = true;
      if (st.res) st.res.quietDestroy();
      st.req.destroy();
      return;
    }
    st.done = true;
    closeUpstream(st, why === 'window_exceeded' ? 1008 : 1001, '');
  }

  // ── relay.ws.* ───────────────────────────────────────────────────────────
  function closeUpstream(st, code, reason) {
    const up = st.upstream;
    if (!up) return;
    try { up.close(code, reason); } catch {
      try { up.close(1000); } catch { up.terminate(); }
    }
    const t = setTimeout(() => { try { up.terminate(); } catch { /* gone */ } }, CLOSE_WITHIN_MS);
    if (t.unref) t.unref();
  }

  // End a ws relay from this side: a relay.ws.close to the hub, the upstream
  // closed (when `upstreamCode`), the stream released.
  function endWs(st, { code, reason = '', upstreamCode = null }) {
    if (st.done) return;
    st.done = true;
    relays.delete(st.stream);
    link.send('relay', 'relay.ws.close', { stream: st.stream, code, ...(reason ? { reason } : {}) });
    if (upstreamCode != null) closeUpstream(st, upstreamCode, '');
    link.streams.close(st.stream);
  }

  function wsRefused(f, status, body) {
    link.send('relay', 'relay.ws.refused', { stream: f.stream, status, body }, { re: f.id });
  }

  // The daemon's own refusal body, when it is the {ok, remote, error} shape
  // 05's refused body admits; else NOT_ANSWERING.
  function upstreamRefusalBody(buf) {
    let p = null;
    try { p = buf ? JSON.parse(buf.toString('utf8')) : null; } catch { p = null; }
    if (isPlainObject(p) && Object.keys(p).length === 3 && p.ok === false && p.remote === true
      && typeof p.error === 'string' && p.error.length <= 500) return p;
    return NOT_ANSWERING;
  }

  async function onWsOpen(f) {
    const pend = { cancelled: false };
    opening.set(f.stream, pend);
    const q = {
      chat: f.chat, surface: 'session', method: 'GET', path: f.path, headers: {},
      decision: f.decision, decision_ref: f.decision_ref, actor: f.actor, upgrade: true,
    };
    let g;
    try { g = await gate(q); } finally { opening.delete(f.stream); }
    if (pend.cancelled) return;
    if (!g.ok) {
      emitDeny(g.deny);
      say(`relay ws refused ${g.status}${g.deny ? ` ${g.deny.reason}` : ''}`);
      wsRefused(f, g.status, g.body);
      return;
    }
    const st = {
      kind: 'ws', stream: f.stream, chat: f.chat, decision: g.decision, pk: principalKey(g.decision),
      upstream: null, opened: false, done: false, out: [], pumping: false, frag: null, q, g,
    };
    const slot = link.streams.open(f.stream, f.chat, { kind: 'ws', onEnd: (why) => onStreamEnd(f.stream, why) });
    if (!slot.ok) {
      say(`relay stream refused ${slot.reason}`);
      if (slot.reason === 'link_full' || slot.reason === 'chat_full') wsRefused(f, 429, BUSY);
      return;
    }
    relays.set(f.stream, st);
    let up;
    try {
      up = openUpstream({ port: g.target.rec.port, userAgent: f.user_agent || null, stamp: g.stamp, collectRefusal: true });
    } catch (e) {
      say(`relay ws error ${e && e.name ? e.name : 'Error'}`);
      relays.delete(f.stream);
      wsRefused(f, 502, NOT_ANSWERING);
      link.streams.close(f.stream);
      return;
    }
    st.upstream = up;
    up.on('open', () => {
      if (st.done) { try { up.close(1000); } catch { up.terminate(); } return; }
      st.opened = true;
      link.send('relay', 'relay.ws.opened', { stream: f.stream }, { re: f.id });
      up.deliver();
    });
    up.on('refused', (status, body) => {
      if (st.done) return;
      st.done = true;
      relays.delete(f.stream);
      if (status === 403) daemonDeny(q, g, body || Buffer.alloc(0));
      wsRefused(f, 502, upstreamRefusalBody(body));
      link.streams.close(f.stream);
    });
    up.on('error', () => {
      if (st.opened || st.done) return; // after open, 'close' follows
      st.done = true;
      relays.delete(f.stream);
      wsRefused(f, 502, NOT_ANSWERING);
      link.streams.close(f.stream);
    });
    up.on('message', (data, isBinary) => {
      if (st.done) return;
      st.out.push({ buf: Buffer.isBuffer(data) ? data : Buffer.from(data), binary: !!isBinary, offset: 0 });
      kick(st);
    });
    up.on('close', (code, reason) => {
      if (st.done) return;
      st.out.push({ close: mapCloseCode(code), reason: cutReason(reason) });
      kick(st);
    });
  }

  function kick(st) {
    if (!st.pumping) pump(st).catch(() => {});
  }

  // Daemon → hub, in order, each fragment waiting for send credit; the
  // upstream is paused while it waits (C-05.22).
  async function pump(st) {
    st.pumping = true;
    try {
      while (st.out.length && !st.done) {
        const item = st.out[0];
        if (item.close != null) {
          st.out.shift();
          endWs(st, { code: item.close, reason: item.reason });
          return;
        }
        const p = pieceOf(item.buf, item.offset, item.binary);
        if (link.streams.credit(st.stream) < p.n && !st.upstream.isPaused) st.upstream.pause();
        await link.streams.sendCredit(st.stream, p.n);
        if (st.done) return;
        item.offset = p.end;
        const more = item.offset < item.buf.length;
        if (!more) st.out.shift();
        link.send('relay', 'relay.ws.data', { stream: st.stream, binary: item.binary, ...(more ? { more: true } : {}), data: p.data });
      }
    } catch {
      return; // the stream ended while waiting: onStreamEnd tears it down
    } finally {
      st.pumping = false;
    }
    if (!st.done && st.upstream && st.upstream.isPaused) st.upstream.resume();
  }

  // Hub → daemon: reassemble, then the inbound filter (C-04.18).
  function onWsData(f) {
    const st = relays.get(f.stream);
    if (!st || st.kind !== 'ws' || st.done) return;
    const bytes = f.binary ? Buffer.from(f.data, 'base64') : Buffer.from(f.data, 'utf8');
    grant(st.stream, bytes.length);
    if (!st.frag) st.frag = { binary: f.binary, parts: [], size: 0, bad: false };
    const m = st.frag;
    if (m.binary !== f.binary) m.bad = true;
    m.size += bytes.length;
    if (m.size > INBOUND_MAX) m.parts = null;
    else if (m.parts) m.parts.push(bytes);
    if (f.more) return;
    st.frag = null;
    inbound(st, m);
  }

  function inbound(st, m) {
    const drop = (reason, type, need) => {
      say(`relay ws dropped ${reason}`);
      emitDeny({
        enforcer: 'connector', origin: 'ws-inbound', method: 'MSG', path: (type || '').slice(0, PATH_MAX),
        rule: null, need, reason, status: null,
        principal: st.decision.principal, chat_id: st.chat, machine_id: st.q.machineId, decision_id: st.decision.decision_id,
      });
    };
    if (m.bad || m.binary || !m.parts) { drop('malformed', '', null); return; }
    const text = Buffer.concat(m.parts, m.size).toString('utf8');
    let msg = null;
    try { msg = JSON.parse(text); } catch { msg = null; }
    if (!isPlainObject(msg) || typeof msg.type !== 'string') { drop('malformed', '', null); return; }
    const type = msg.type;
    const level = connected.wsInboundLevel(type);
    if (level == null) { drop('unknown', type, null); return; }
    if (level === 'host_only' || level === 'retired') { drop(level === 'retired' ? 'retired' : 'host-only', type, level); return; }
    if (!holds(st.decision, level)) { drop('level', type, level); return; }
    if (!underCeiling(level, thisMachine().ceiling)) { drop('ceiling', type, level); return; }
    st.upstream.send(text);
  }

  function onWsClose(f) {
    const pend = opening.get(f.stream);
    if (pend) { pend.cancelled = true; return; }
    const st = relays.get(f.stream);
    if (!st || st.kind !== 'ws' || st.done) return;
    st.done = true;
    relays.delete(f.stream);
    closeUpstream(st, f.code, typeof f.reason === 'string' ? f.reason : '');
  }

  // ── the channel ──────────────────────────────────────────────────────────
  const handlers = {
    'relay.decision': onDecisionFrame,
    'relay.http.request': onHttpRequest,
    'relay.http.body': onHttpBody,
    'relay.http.abort': () => {}, // the link ends the stream after dispatch: onStreamEnd
    'relay.ws.open': onWsOpen,
    'relay.ws.data': onWsData,
    'relay.ws.close': onWsClose,
  };
  const unregister = link.channel('relay', {
    kinds: Object.keys(handlers),
    handle(f) {
      const r = handlers[f.kind](f);
      if (r && typeof r.then === 'function') {
        return r.then(null, (e) => { say(`relay handler failed ${f.kind} ${e && e.code ? e.code : 'Error'}`); });
      }
      return r;
    },
  });

  // Decisions and in-gate opens die with the link (A-05.3); the link's streams
  // end through onStreamEnd ('link_closed').
  const onLinkClosed = () => {
    held = new Map();
    versions = new Map();
    for (const pend of opening.values()) pend.cancelled = true;
  };
  link.on('closed', onLinkClosed);

  // ── the one-shot request (U717-U728@one-shot-relayed-request (a)) ────────
  // A request the connector itself originates (C-07.26's queue delivery):
  // gate steps (1)–(6), the same stamp and identity, the same 'deny' events,
  // and no stream slot. → {status, headers, body: Buffer, aborted?}
  async function request({
    chat, decision, decision_ref, surface = 'session', method = 'POST', path, headers = {}, body = null, actor,
  } = {}) {
    const q = {
      chat, surface, method, path, headers: isPlainObject(headers) ? headers : {},
      decision, decision_ref, actor, upgrade: false,
    };
    const g = await gate(q);
    if (!g.ok) {
      emitDeny(g.deny);
      say(`relay request refused ${g.status}${g.deny ? ` ${g.deny.reason}` : ''}`);
      return { status: g.status, headers: refusalHeaders(q), body: jsonBytes(g.body) };
    }
    const bytes = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const req = Readable.from(bytes && bytes.length ? [bytes] : []);
    req.method = method;
    req.url = path;
    req.headers = q.headers;
    const chunks = [];
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const res = new RelaySink({
      head() {},
      body(_sink, chunk) { chunks.push(Buffer.from(chunk)); },
      end(sink) {
        if (sink.statusCode === 403) daemonDeny(q, g, sink.peekBody());
        resolveDone({ status: sink.statusCode, headers: frameHeaders(sink.headers), body: Buffer.concat(chunks) });
      },
      abort(sink) {
        resolveDone({ status: sink.statusCode || 502, headers: frameHeaders(sink.headers), body: Buffer.concat(chunks), aborted: true });
      },
    });
    res.on('close', () => {
      if (!res.finishedOk) resolveDone({ status: res.statusCode || 502, headers: frameHeaders(res.headers), body: Buffer.concat(chunks), aborted: true });
    });
    await proxySafely(q, g, req, res);
    return done;
  }

  function stop() {
    unregister();
    link.removeListener('closed', onLinkClosed);
    for (const st of [...relays.values()]) {
      relays.delete(st.stream);
      if (st.kind === 'http') {
        st.aborted = true;
        if (st.res) st.res.quietDestroy();
        st.req.destroy();
      } else {
        st.done = true;
        if (st.upstream) st.upstream.terminate();
      }
    }
    for (const pend of opening.values()) pend.cancelled = true;
    held = new Map();
    versions = new Map();
  }

  relay.request = request;
  relay.stop = stop;
  Object.defineProperty(relay, 'openCount', { get: () => relays.size, enumerable: true });
  return relay;
}

// CONNECTOR@install-seam: U790 hands the connector's ctx; the relay is the
// emitter U730 subscribes to for 'deny'.
function install(ctx = {}) {
  return createRelay(ctx);
}

module.exports = {
  createRelay,
  install,
  mapCloseCode,
  cutReason,
  grantsOf,
  actorLine,
  decisionOk,
  CHUNK,
  INBOUND_MAX,
  IDENTITY_MEMO_MS,
  REFUSAL_PEEK,
  NOT_RUNNING,
};

'use strict';

// The connector's one WebSocket to the hub (contract 05 §3.2–§3.6, C-05.4 to
// C-05.25, with A-05.1 and A-05.2; 06 C-06.10; 07 C-07.34; tranche 6, U716).
//
//   createLink({ record, key, versions, facts, routeTable, heartbeatBody,
//                onSettings, log, timers, random, now, writeKey }) → link
//
// DIAL (C-05.4, C-05.10a). The URL comes from the record's hub origin and
// nothing else (06-connector-state.json: "the connector dials only this
// origin"): https://<host> → wss://<host>/connector; http://<host> →
// ws://<host>/connector ONLY for a loopback literal of lib/core/cors
// LOCAL_HOSTNAMES — a record holds such an origin only when hubOrigin was
// called with insecureLoopback (the tests' fake hub; the CLI never passes it
// in alpha.7), which is C-05.4's development flag that "refuses every
// non-loopback hub". Anything else throws before a socket exists. hello.ack's
// hub.origin is information and never replaces the origin dialled. TLS
// verification is the ws package's default and nothing here relaxes it; no
// credential travels in the URL or a header; the client socket caps a message
// at 4 MiB (C-05.10a) and always has an `error` listener.
//
// AUTH (C-05.5, C-05.7, C-05.8). The hub's auth.challenge (within 10 s of the
// open) is answered with a signature over
// `web-chat-connector-auth/1\n<host>\n<nonce>\n<machine_id>\n<key_id>`, where
// <host> is new URL(origin).host, port included. auth.ok `rotate: true` → a new
// Ed25519 pair in memory and key.rotate signed by both keys (sent after
// hello.ack: only ping and heartbeat may precede it); on key.rotated, or on a
// later auth.ok naming the new key id when the link dropped first, the new key
// is written (writeKey, by default lib/setup/connector.js writeMachineKey —
// the one key-file writer: the key atomically at 0600 and the record's key
// fields under the record's lock) and replaces the old one in memory. The
// key id and fingerprint are lib/setup/connector.js's (keyIdOf,
// fingerprintOf): none is derived here.
//
// HELLO (C-05.12 to C-05.15, C-06.10). hello carries versions() (12's
// record), routeTable() ({table_version, sha256}, C-04.19) and the protocol-1
// capabilities; hello.ack's values are checked here (helloAckValues: the
// beat and dead bounds, the windows' keys and floors with C-05.23's 256 / 64
// stream ceilings, an ok / ahead / behind verdict — else bad_frame, fatal);
// its compat verdict is link.compat (logged when it changes); hello.refused is "needs update" and the 4426 that follows takes
// the slow backoff — the connector never exits for it (C-12.14).
//
// FRAMES (C-05.10, C-05.11, A-05.1): ./frames reads each inbound message in
// C-05.10's order against FRAME_SHAPES; a fatal case answers control.error
// with fatal and closes 4400, an unknown kind answers a non-fatal unknown_kind
// and nothing runs. Outbound, every frame is measured encoded against 1 MiB
// before it is queued (send() throws past it; it never truncates), and its
// text is checked against every registered secret (a hit drops the frame and
// logs a code). seq counts per connection, channel and direction from 1.
//
// LIVENESS AND CLOSE (C-05.9 as A-05.1 replaces it, C-05.16, C-05.17). A
// heartbeat every heartbeat_ms carrying 07's body from heartbeatBody(); any
// inbound frame resets the dead timer; dead_after_ms of silence closes 4408.
// closeAction() is C-05.9's table: any code it does not name (1006 included)
// takes normal backoff. Every timer goes through `timers` and every draw
// through `random`, so a test runs the cadence in virtual time.
//
// FLOW CONTROL (C-05.21 to C-05.25). One queue per channel (two inside
// events: ring batches before derived signals), written while the socket
// buffers under 1 MiB in the order control, queue, events, relay; control is
// never held back. link.streams is the relay stream table (256 per link, 64
// per chat, credit each way in decoded bytes); batchSlot(chat) is the ring's
// window (4 unacknowledged per chat); signalRoom() the derived signals'.
//
// THE SEAM (CONNECTOR@install-seam). link.channel(ch, {kinds, handle}) is how
// every other module hears its frames; send / request / on / registerSecret /
// factsChanged are what they call. No module edits this file.
//
// NEVER on the link or in a log line (C-05.50, C-11.20): the private key, a
// relay secret, a writer token, a daemon's port or pid. Log lines carry codes,
// ids and counts only: no frame body, nonce, signature or path. No listening
// socket is opened here and nothing here reads a daemon.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const { packageVersion } = require('../core/versions');
const { LOCAL_HOSTNAMES } = require('../core/cors');
const { keyIdOf, fingerprintOf, writeMachineKey } = require('../setup/connector');
const { FRAME_MAX, MAX_PAYLOAD, SUBPROTOCOL, CHANNELS, ID_RE, KIND_RE, readFrame } = require('./frames');

const CONNECTOR_PATH = '/connector';
const AUTH_PREFIX = 'web-chat-connector-auth/1';
const ROTATE_PREFIX = 'web-chat-connector-rotate/1';

const AUTH_WAIT_MS = 10 * 1000;          // C-05.5: the challenge comes within 10 s
const HELLO_ACK_WAIT_MS = 30 * 1000;     // an unanswered hello is a protocol error
const HANDSHAKE_MS = 15 * 1000;          // the upgrade itself (ws's own timer)
const CLOSE_GRACE_MS = 5 * 1000;         // a close handshake that does not finish is cut
const HEARTBEAT_MS = 15000;              // C-05.17, until hello.ack says otherwise
const DEAD_AFTER_MS = 45000;
const BUFFER_HIGH = 1024 * 1024;         // C-05.21
const BACKOFF_BASE_MS = 1000;            // C-05.9: full jitter on min(60 s, 1 s × 2^n)
const BACKOFF_CAP_MS = 60 * 1000;
const BACKOFF_RESET_MS = 60 * 1000;      // reset after 60 s connected
const SLOW_MS = 15 * 60 * 1000;          // slow: 15 minutes ±20%
const SLOW_JITTER = 0.2;
const RATE_LIMITED_MIN_MS = 60 * 1000;   // 4429: at least 60 s
const REQUEST_TIMEOUT_MS = 30 * 1000;
const SECRET_MIN = 8;

// The windows hello.ack restates (protocol 1's values until it does).
const WINDOWS_DEFAULT = Object.freeze({
  relay_stream_bytes: 256 * 1024,
  relay_streams_max: 256,
  relay_streams_per_chat: 64,
  signals_unacked: 256,
  batches_unacked_per_chat: 4,
  frame_bytes_max: FRAME_MAX,
});

// hello.ack's values as 05-hello.json bounds them: each window's floor, and
// the ceilings C-05.23 fixes ("At most 256 streams per link and 64 per chat").
const WINDOW_MIN = Object.freeze({
  relay_stream_bytes: 65536,
  relay_streams_max: 1,
  relay_streams_per_chat: 1,
  signals_unacked: 1,
  batches_unacked_per_chat: 1,
  frame_bytes_max: 65536,
});
const WINDOW_CAP = Object.freeze({ relay_streams_max: 256, relay_streams_per_chat: 64 });
const HEARTBEAT_RANGE = Object.freeze([5000, 30000]);
const DEAD_AFTER_RANGE = Object.freeze([15000, 120000]);
const ACK_COMPAT_STATES = new Set(['ok', 'ahead', 'behind']);   // refused rides hello.refused

const inRange = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

// The values a hello.ack fixes, checked by the module that reads them (the
// frame table checks top-level types only): null when one fails, which the
// link answers as bad_frame (A-05.1: fatal); else the windows with C-05.23's
// stream ceilings applied.
function helloAckValues(f) {
  if (!inRange(f.heartbeat_ms, HEARTBEAT_RANGE)) return null;
  if (!inRange(f.dead_after_ms, DEAD_AFTER_RANGE) || f.dead_after_ms <= f.heartbeat_ms) return null;
  if (!isPlainObject(f.compat) || !ACK_COMPAT_STATES.has(f.compat.state)) return null;
  const w = f.windows;
  if (!isPlainObject(w)) return null;
  const keys = Object.keys(w);
  const names = Object.keys(WINDOW_MIN);
  if (keys.length !== names.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(WINDOW_MIN, k))) return null;
  const out = {};
  for (const k of names) {
    if (!Number.isInteger(w[k]) || w[k] < WINDOW_MIN[k]) return null;
    out[k] = Object.prototype.hasOwnProperty.call(WINDOW_CAP, k) ? Math.min(w[k], WINDOW_CAP[k]) : w[k];
  }
  return out;
}

// The protocol-1 capability names this build serves (C-05.12).
const CAPABILITIES = Object.freeze([
  'relay.http', 'relay.ws', 'relay.answer', 'relay.decision_ref', 'events.batch', 'events.signals',
  'authority.log', 'queue.message', 'key.rotate',
]);

// The derived signals (C-05.24): their own queue inside events, behind batches.
const SIGNAL_KINDS = new Set(['turn.begun', 'turn.ended', 'ask.opened', 'ask.updated', 'ask.closed', 'conversations', 'resync']);

// Kinds the link answers itself: no module may register for them.
const LINK_KINDS = new Set([
  'control\0auth.challenge', 'control\0auth.ok', 'control\0auth.refused', 'control\0key.rotated',
  'control\0hello.ack', 'control\0hello.refused', 'control\0compat.update', 'control\0ping',
  'control\0control.error', 'control\0machine.settings', 'control\0machine.revoked',
  'relay\0relay.window', 'events\0signals.ack',
]);

// The order the outbound queues are written in (C-05.21).
const QUEUE_ORDER = Object.freeze(['control', 'queue', 'batches', 'signals', 'relay']);

// C-05.9 as A-05.1 replaces it: code → what the connector does next.
const CLOSE_RULES = Object.freeze({
  1000: 'stop',
  1001: 'normal',
  1009: 'normal',
  4400: 'normal',
  4401: 'normal',
  4403: 'revoked',
  4408: 'redial',
  4409: 'superseded',
  4423: 'slow',
  4426: 'slow',
  4429: 'rate',
  4440: 'redial',
  4503: 'normal',
});

function closeAction(code) {
  return Object.prototype.hasOwnProperty.call(CLOSE_RULES, code) ? CLOSE_RULES[code] : 'normal';
}

// Full jitter on min(60 s, 1 s × 2^n).
function backoffDelay(n, random = Math.random) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(Math.max(0, n), 16));
  return Math.floor(random() * ceiling);
}

// 15 minutes ±20%.
function slowDelay(random = Math.random) {
  return Math.round(SLOW_MS * (1 - SLOW_JITTER + 2 * SLOW_JITTER * random()));
}

// The URL the link dials, from the record's origin alone (C-05.4).
function dialUrl(origin) {
  let url;
  try { url = new URL(origin); } catch { throw linkError('EHUBORIGIN', 'the hub origin is not a URL'); }
  if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw linkError('EHUBORIGIN', 'the hub origin carries more than a scheme and a host');
  }
  if (url.protocol === 'https:') return `wss://${url.host}${CONNECTOR_PATH}`;
  if (url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)) return `ws://${url.host}${CONNECTOR_PATH}`;
  throw linkError('EHUBORIGIN', 'the hub must be reached over https (plain http only to a loopback host)');
}

function linkError(code, message) {
  const e = new Error(`connector link: ${message}`);
  e.code = code;
  return e;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const token = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : '?');
const errCode = (e) => token(e && typeof e.code === 'string' ? e.code : 'error');

// The raw 32-byte public half of an Ed25519 key (private or public KeyObject).
function rawPublic(keyObject) {
  const pub = keyObject.type === 'private' ? crypto.createPublicKey(keyObject) : keyObject;
  return Buffer.from(pub.export({ format: 'jwk' }).x, 'base64url');
}

function holdKey(privateKey) {
  if (!privateKey || typeof privateKey !== 'object' || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('connector link: key must be an Ed25519 private KeyObject');
  }
  const raw = rawPublic(privateKey);
  return { privateKey, raw, publicWire: raw.toString('base64url'), keyId: keyIdOf(raw), fingerprint: fingerprintOf(raw) };
}

// Every text form a private key could take inside a JSON frame.
function keySecrets(privateKey) {
  const d = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return [
    d.toString('base64url'), d.toString('base64'), d.toString('hex'),
    der.toString('base64url'), der.toString('base64'), der.toString('hex'),
    pem, JSON.stringify(pem).slice(1, -1),
  ];
}

// The default key writer (C-05.7; K.2-312): lib/setup/connector.js
// writeMachineKey, the ONE writer of the key file — the key atomically at 0600
// and the record's key fields in one critical section under the record's lock.
// This module opens no key file of its own.
function defaultWriteKey({ hubId, pem, keyId, publicKey, fingerprint }) {
  writeMachineKey({ hubId, pem, keyId, publicKey, fingerprint });
}

// The 07 heartbeat body until U729's rows are wired: no chat rows.
function minimalHeartbeat({ machine_id, beat, interval_ms, connector_now, echo_at }) {
  return {
    type: 'heartbeat', machine_id, beat, interval_ms, connector_now,
    ...(Number.isInteger(echo_at) ? { echo_at } : {}),
    chats: [],
  };
}

function createLink({
  record,
  key,
  versions,
  facts,
  routeTable,
  heartbeatBody = minimalHeartbeat,
  onSettings = () => {},
  log = () => {},
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  random = Math.random,
  now = Date.now,
  writeKey = defaultWriteKey,
} = {}) {
  if (!isPlainObject(record) || !isPlainObject(record.hub) || typeof record.hub.origin !== 'string') {
    throw new TypeError('connector link: a record with hub.origin is required');
  }
  if (!isPlainObject(record.machine) || typeof record.machine.id !== 'string') {
    throw new TypeError('connector link: the record names no machine (pair first)');
  }
  for (const [name, fn] of [['versions', versions], ['facts', facts], ['routeTable', routeTable]]) {
    if (typeof fn !== 'function') throw new TypeError(`connector link: ${name} must be a function`);
  }
  const url = dialUrl(record.hub.origin);
  const host = new URL(record.hub.origin).host;
  const hubId = record.hub.id;
  const machineId = record.machine.id;
  const T = timers;

  const link = new EventEmitter();
  const say = (line) => { try { log(line); } catch { /* the log's own failure */ } };
  const secrets = new Set();
  const handlers = new Map();      // `${ch}\0${kind}` → handler
  const pending = new Map();       // request id → { resolve, reject, timer, conn }

  let current = holdKey(key);
  for (const s of keySecrets(current.privateKey)) secrets.add(s);
  let rotation = null;             // { privateKey, raw, publicWire, keyId, fingerprint }
  let conn = null;                 // the connection now in hand
  let retryTimer = null;
  let attempt = 0;
  let stopped = true;
  let ended = null;                // 'revoked' | 'superseded' once the link may not dial again
  let compat = null;
  let compatLogged = null;
  let needsUpdate = false;
  let info = null;
  let nextRetry = null;
  let revokedSeen = false;
  let settingsRev = isPlainObject(record.settings) && Number.isInteger(record.settings.rev) ? record.settings.rev : null;
  let stopWaiters = [];

  // ── timers ────────────────────────────────────────────────────────────────
  function after(c, ms, fn) {
    const h = T.setTimeout(() => { c.timers.delete(h); fn(); }, ms);
    c.timers.add(h);
    return h;
  }
  function cancel(c, h) {
    if (h == null) return;
    c.timers.delete(h);
    T.clearTimeout(h);
  }
  function clearConnTimers(c) {
    for (const h of c.timers) T.clearTimeout(h);
    c.timers.clear();
    if (c.beatTimer != null) { T.clearInterval(c.beatTimer); c.beatTimer = null; }
  }

  // ── secrets ───────────────────────────────────────────────────────────────
  function holdsSecret(text) {
    for (const s of secrets) if (text.includes(s)) return true;
    return false;
  }
  function registerSecret(value) {
    const forms = [];
    if (typeof value === 'string') {
      if (value.length < SECRET_MIN) throw new TypeError(`registerSecret: a secret is at least ${SECRET_MIN} characters`);
      forms.push(value);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) forms.push(escaped);
    } else if (value instanceof Uint8Array) {
      if (value.length < SECRET_MIN / 2) throw new TypeError('registerSecret: a secret is at least 4 bytes');
      const b = Buffer.from(value);
      forms.push(b.toString('base64url'), b.toString('base64'), b.toString('hex'));
    } else {
      throw new TypeError('registerSecret: a string or bytes');
    }
    const added = forms.filter((f) => !secrets.has(f));
    for (const f of added) secrets.add(f);
    return () => { for (const f of added) secrets.delete(f); };
  }

  // ── encoding ──────────────────────────────────────────────────────────────
  const ENVELOPE_KEYS = ['ch', 'kind', 'id', 'seq', 're', 'at'];
  function encode(ch, kind, id, seq, re, at, body) {
    return JSON.stringify({ ch, kind, id, seq, ...(re != null ? { re } : {}), at, ...body });
  }
  function checkOutbound(ch, kind, body, re) {
    if (!CHANNELS.includes(ch)) throw linkError('EFRAME', 'not a protocol-1 channel');
    if (typeof kind !== 'string' || !KIND_RE.test(kind)) throw linkError('EFRAME', 'not a frame kind');
    if (!isPlainObject(body)) throw linkError('EFRAME', 'a frame body is an object');
    for (const k of ENVELOPE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, k)) throw linkError('EFRAME', `the body may not carry the envelope's ${k}`);
    }
    if (re != null && (typeof re !== 'string' || !ID_RE.test(re))) throw linkError('EFRAME', 're is not a frame id');
  }

  // ── writing ───────────────────────────────────────────────────────────────
  function nextSeq(c, ch) {
    c.outSeq[ch] = (c.outSeq[ch] || 0) + 1;
    return c.outSeq[ch];
  }
  function write(c, item) {
    const seq = nextSeq(c, item.ch);
    const text = encode(item.ch, item.kind, item.id, seq, item.re, Math.max(0, Math.floor(now())), item.body);
    if (item.ch === 'events' && SIGNAL_KINDS.has(item.kind)) c.signalSeqs.push(seq);
    try {
      c.ws.send(text, (err) => {
        if (err || !c.waitingDrain) return;
        c.waitingDrain = false;
        flush(c);
      });
    } catch (e) {
      say(`link write failed ${errCode(e)}`);
    }
  }
  // A frame the link sends itself (auth, hello, heartbeat, errors, facts,
  // rotation): written now, never queued, still measured and checked.
  function sendNow(c, ch, kind, body, { re } = {}) {
    if (!c || c.closed || !c.ws || c.ws.readyState !== WebSocket.OPEN) return null;
    checkOutbound(ch, kind, body, re);
    const id = `c${++c.ids}`;
    const probe = encode(ch, kind, id, Number.MAX_SAFE_INTEGER, re, Number.MAX_SAFE_INTEGER, body);
    if (Buffer.byteLength(probe) > FRAME_MAX) throw linkError('ELINKFRAME', `a ${kind} frame passes 1 MiB encoded`);
    if (holdsSecret(probe)) { say(`link dropped ${kind} code=secret`); return null; }
    write(c, { ch, kind, id, re, body });
    return id;
  }
  function queueOf(ch, kind) {
    if (ch !== 'events') return ch;
    return SIGNAL_KINDS.has(kind) ? 'signals' : 'batches';
  }
  function flush(c) {
    if (!c || c.closed || c.state !== 'up' || c.ws.readyState !== WebSocket.OPEN) return;
    for (;;) {
      if (c.queues.control.length) { write(c, c.queues.control.shift()); continue; }
      const name = QUEUE_ORDER.find((q) => q !== 'control' && c.queues[q].length);
      if (!name) return;
      if (c.ws.bufferedAmount >= BUFFER_HIGH) { c.waitingDrain = true; return; }
      write(c, c.queues[name].shift());
    }
  }

  // send(ch, kind, body, {re}) → the frame id, or null when no link is in hand
  // or the frame carried a registered secret. Throws for a frame that is not
  // the protocol's or passes 1 MiB encoded.
  function send(ch, kind, body = {}, { re } = {}) {
    checkOutbound(ch, kind, body, re);
    const c = conn;
    if (!c || c.closed || c.closing != null) { say(`link not up; ${token(kind)} not sent`); return null; }
    const id = `c${++c.ids}`;
    const probe = encode(ch, kind, id, Number.MAX_SAFE_INTEGER, re, Number.MAX_SAFE_INTEGER, body);
    if (Buffer.byteLength(probe) > FRAME_MAX) throw linkError('ELINKFRAME', `a ${token(kind)} frame passes 1 MiB encoded`);
    if (holdsSecret(probe)) { say(`link dropped ${token(kind)} code=secret`); return null; }
    c.queues[queueOf(ch, kind)].push({ ch, kind, id, re, body });
    flush(c);
    return id;
  }

  function request(ch, kind, body = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    let id;
    try { id = send(ch, kind, body); } catch (e) { return Promise.reject(e); }
    if (!id) return Promise.reject(linkError('ELINKDOWN', 'no link to the hub is up'));
    const c = conn;
    return new Promise((resolve, reject) => {
      const timer = T.setTimeout(() => {
        pending.delete(id);
        reject(linkError('ETIMEDOUT', `no answer to ${token(kind)}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, conn: c });
    });
  }

  // ── the seam ──────────────────────────────────────────────────────────────
  function channel(ch, { kinds, handle } = {}) {
    if (!CHANNELS.includes(ch)) throw new TypeError(`channel: ${token(ch)} is not a protocol-1 channel`);
    if (!Array.isArray(kinds) || !kinds.length || typeof handle !== 'function') {
      throw new TypeError('channel: { kinds: [..], handle(frame, link) } is required');
    }
    const keys = kinds.map((k) => {
      if (typeof k !== 'string' || !KIND_RE.test(k)) throw new TypeError('channel: not a frame kind');
      const key = `${ch}\0${k}`;
      if (LINK_KINDS.has(key)) throw new Error(`channel: ${k} is the link's own`);
      if (handlers.has(key)) throw new Error(`channel: ${k} on ${ch} is registered twice`);
      return key;
    });
    if (new Set(keys).size !== keys.length) throw new Error('channel: a kind is listed twice');
    for (const key of keys) handlers.set(key, handle);
    return () => { for (const key of keys) if (handlers.get(key) === handle) handlers.delete(key); };
  }

  function dispatch(f) {
    const handle = handlers.get(`${f.ch}\0${f.kind}`);
    if (!handle) { say(`link no handler for ${f.kind}`); return; }
    try {
      const r = handle(f, link);
      if (r && typeof r.then === 'function') r.then(null, () => say(`link handler failed for ${f.kind}`));
    } catch {
      say(`link handler failed for ${f.kind}`);
    }
  }

  // ── relay streams (C-05.20, C-05.22, C-05.23) ────────────────────────────
  function windows() {
    return (info && info.windows) || WINDOWS_DEFAULT;
  }
  function endStream(c, id, reason) {
    const st = c.streams.get(id);
    if (!st) return;
    c.streams.delete(id);
    const n = (c.perChat.get(st.chat) || 1) - 1;
    if (n > 0) c.perChat.set(st.chat, n); else c.perChat.delete(st.chat);
    for (const w of st.waiters.splice(0)) w.reject(linkError('ESTREAM', `stream ended: ${reason}`));
    if (st.onEnd) { try { st.onEnd(reason); } catch { /* the caller's */ } }
  }
  const streams = {
    // Refuses past 256 streams per link or 64 per chat (the caller answers 429).
    open(stream, chat, { kind = 'http', onEnd } = {}) {
      const c = conn;
      if (!c || c.state !== 'up') return { ok: false, reason: 'not_up' };
      if (!Number.isInteger(stream) || stream < 1) return { ok: false, reason: 'bad_stream' };
      if (typeof chat !== 'string' || !chat) return { ok: false, reason: 'bad_chat' };
      if (c.streams.has(stream)) return { ok: false, reason: 'exists' };
      const w = windows();
      if (c.streams.size >= w.relay_streams_max) return { ok: false, reason: 'link_full' };
      if ((c.perChat.get(chat) || 0) >= w.relay_streams_per_chat) return { ok: false, reason: 'chat_full' };
      c.streams.set(stream, {
        chat, kind: kind === 'ws' ? 'ws' : 'http', onEnd: typeof onEnd === 'function' ? onEnd : null,
        sendCredit: w.relay_stream_bytes, recvCredit: w.relay_stream_bytes, recvUsed: 0, waiters: [],
      });
      c.perChat.set(chat, (c.perChat.get(chat) || 0) + 1);
      return { ok: true };
    },
    close(stream) {
      if (conn) endStream(conn, stream, 'closed');
    },
    has(stream) { return !!conn && conn.streams.has(stream); },
    get count() { return conn ? conn.streams.size : 0; },
    countFor(chat) { return conn ? conn.perChat.get(chat) || 0 : 0; },
    credit(stream) {
      const st = conn && conn.streams.get(stream);
      return st ? st.sendCredit : 0;
    },
    // Resolves (and spends n) once the hub has granted n bytes on this stream.
    sendCredit(stream, n) {
      const st = conn && conn.streams.get(stream);
      if (!st) return Promise.reject(linkError('ESTREAM', 'no such stream'));
      if (!Number.isInteger(n) || n < 0) return Promise.reject(new TypeError('sendCredit: n is a byte count'));
      if (!st.waiters.length && st.sendCredit >= n) { st.sendCredit -= n; return Promise.resolve(n); }
      return new Promise((resolve, reject) => st.waiters.push({ n, resolve, reject }));
    },
    // Counts n decoded bytes the hub sent; false (and the stream aborted with
    // window_exceeded) when it passes the credit granted.
    receive(stream, n) {
      const c = conn;
      const st = c && c.streams.get(stream);
      if (!st) return false;
      st.recvUsed += n;
      if (st.recvUsed <= st.recvCredit) return true;
      say(`link stream ${stream} window_exceeded`);
      if (st.kind === 'http') sendNow(c, 'relay', 'relay.http.abort', { stream, reason: 'window_exceeded' });
      else sendNow(c, 'relay', 'relay.ws.close', { stream, code: 1008, reason: 'window_exceeded' });
      endStream(c, stream, 'window_exceeded');
      return false;
    },
    // Grants the hub n more bytes as the sink drains (relay.window).
    grant(stream, n) {
      const st = conn && conn.streams.get(stream);
      if (!st || !Number.isInteger(n) || n <= 0) return null;
      st.recvCredit += n;
      return send('relay', 'relay.window', { stream, bytes: n });
    },
  };
  function onWindow(c, f) {
    const st = c.streams.get(f.stream);
    if (!st) return;
    if (f.bytes > 0) st.sendCredit += f.bytes;
    while (st.waiters.length && st.sendCredit >= st.waiters[0].n) {
      const w = st.waiters.shift();
      st.sendCredit -= w.n;
      w.resolve(w.n);
    }
  }
  function decodedBytes(f) {
    if (f.kind === 'relay.http.body') return Buffer.byteLength(f.body, 'base64');
    return f.binary ? Buffer.byteLength(f.data, 'base64') : Buffer.byteLength(f.data, 'utf8');
  }

  // ── ring batches and derived signals (C-05.24) ───────────────────────────
  function batchSlot(chat) {
    const c = conn;
    if (!c || c.state !== 'up' || typeof chat !== 'string' || !chat) return false;
    const n = c.batches.get(chat) || 0;
    if (n >= windows().batches_unacked_per_chat) return false;
    c.batches.set(chat, n + 1);
    return true;
  }
  function signalRoom() {
    const c = conn;
    if (!c || c.state !== 'up') return 0;
    return Math.max(0, windows().signals_unacked - c.signalSeqs.length);
  }
  function onSignalsAck(c, upTo) {
    const before = signalRoom();
    c.signalSeqs = c.signalSeqs.filter((s) => s > upTo);
    if (before === 0 && signalRoom() > 0) link.emit('signals.open');
  }
  function onEventsAck(c, f) {
    const chat = isPlainObject(f.ack) && typeof f.ack.chat_id === 'string' ? f.ack.chat_id : null;
    if (chat === null) return;
    const n = c.batches.get(chat) || 0;
    if (n > 1) c.batches.set(chat, n - 1); else c.batches.delete(chat);
  }

  // ── the connection ───────────────────────────────────────────────────────
  function dial() {
    retryTimer = null;
    if (stopped || ended) return;
    const c = {
      ws: null, state: 'connecting', closing: null, closed: false, viaRedial: false, wasUp: false,
      inSeq: {}, outSeq: {}, ids: 0, timers: new Set(), beatTimer: null, beat: 0, lastPingAt: null,
      queues: Object.fromEntries(QUEUE_ORDER.map((q) => [q, []])), waitingDrain: false,
      streams: new Map(), perChat: new Map(), batches: new Map(), signalSeqs: [],
      challenged: false, rotate: false, rotateId: null, deadTimer: null, deadAfter: DEAD_AFTER_MS,
    };
    c.viaRedial = conn === null && nextRetry !== null && nextRetry.action === 'redial' && nextRetry.delayMs === 0;
    conn = c;
    let ws;
    try {
      ws = new WebSocket(url, SUBPROTOCOL, {
        headers: { 'user-agent': `claude-web-chat-connector/${packageVersion()}` },
        maxPayload: MAX_PAYLOAD,
        perMessageDeflate: false,
        handshakeTimeout: HANDSHAKE_MS,
      });
    } catch (e) {
      say(`link dial failed ${errCode(e)}`);
      onClose(c, 1006);
      return;
    }
    c.ws = ws;
    ws.on('error', (e) => { say(`link socket error ${errCode(e)}`); });
    ws.on('open', () => onOpen(c));
    ws.on('message', (data, isBinary) => onMessage(c, data, isBinary));
    ws.on('close', (code) => onClose(c, code));
  }

  function resetDead(c) {
    cancel(c, c.deadTimer);
    c.deadTimer = after(c, c.deadAfter, () => {
      say('link dead: no frame within dead_after_ms');
      closeConn(c, 4408);
    });
  }

  function onOpen(c) {
    if (c.closed || c !== conn) return;
    c.state = 'auth';
    resetDead(c);
    c.authTimer = after(c, AUTH_WAIT_MS, () => {
      say('link no auth.challenge within 10 s');
      closeConn(c, 4401);
    });
  }

  function closeConn(c, code) {
    if (c.closed || c.closing != null) return;
    c.closing = code;
    c.state = 'closing';
    clearConnTimers(c);
    try { c.ws.close(code); } catch { try { c.ws.terminate(); } catch { /* gone */ } }
    after(c, CLOSE_GRACE_MS, () => { try { c.ws.terminate(); } catch { /* gone */ } });
  }

  function fatal(c, code, re) {
    say(`link fatal ${code}`);
    sendNow(c, 'control', 'control.error', { code, fatal: true }, { re: re || undefined });
    closeConn(c, 4400);
  }

  function onMessage(c, data, isBinary) {
    if (c.closed || c.closing != null || c !== conn) return;
    resetDead(c);
    const r = readFrame(data, isBinary, {
      expectSeq: (ch) => (c.inSeq[ch] || 0) + 1,
      takeSeq: (ch, seq) => { c.inSeq[ch] = seq; },
    });
    if (r.fatal) return fatal(c, r.fatal, r.re);
    if (r.unknown) {
      say(`link unknown_kind on ${r.frame.ch}`);
      sendNow(c, 'control', 'control.error', { code: 'unknown_kind', fatal: false }, { re: r.re || undefined });
      return;
    }
    try {
      onFrame(c, r.frame);
    } catch (e) {
      say(`link frame handling failed ${errCode(e)}`);
    }
  }

  function onFrame(c, f) {
    if (f.re != null && pending.has(f.re) && pending.get(f.re).conn === c) {
      const p = pending.get(f.re);
      pending.delete(f.re);
      T.clearTimeout(p.timer);
      p.resolve(f);
      return;
    }
    switch (`${f.ch}\0${f.kind}`) {
      case 'control\0auth.challenge': return onChallenge(c, f);
      case 'control\0auth.ok': return onAuthOk(c, f);
      case 'control\0auth.refused':
        say(`link auth refused ${token(f.reason)}`);
        return;
      case 'control\0key.rotated': return onRotated(c, f);
      case 'control\0hello.ack': return onHelloAck(c, f);
      case 'control\0hello.refused': return onHelloRefused(c, f);
      case 'control\0compat.update':
        if (c.state === 'up') setCompat(f.compat);
        return;
      case 'control\0ping':
        c.lastPingAt = f.at;
        return;
      case 'control\0control.error':
        say(`link hub error ${token(f.code)}${f.fatal ? ' fatal' : ''}`);
        return;
      case 'control\0machine.settings': return onSettingsFrame(c, f);
      case 'control\0machine.revoked':
        revokedSeen = true;
        say('link machine revoked by the hub');
        return;
      case 'relay\0relay.window': return onWindow(c, f);
      case 'events\0signals.ack': return onSignalsAck(c, f.up_to);
      default:
    }
    if (c.state !== 'up') { say(`link ${f.kind} before hello.ack ignored`); return; }
    if (f.kind === 'events.ack') onEventsAck(c, f);
    if ((f.kind === 'relay.http.body' || f.kind === 'relay.ws.data') && c.streams.has(f.stream)) {
      if (!streams.receive(f.stream, decodedBytes(f))) return;
    }
    dispatch(f);
    if (f.kind === 'relay.http.abort' || f.kind === 'relay.ws.close') endStream(c, f.stream, 'hub_closed');
  }

  function sign(privateKey, text) {
    return crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url');
  }

  function onChallenge(c, f) {
    if (c.state !== 'auth' || c.challenged) { say('link second auth.challenge ignored'); return; }
    c.challenged = true;
    const keyNow = current;
    const signature = sign(keyNow.privateKey, `${AUTH_PREFIX}\n${host}\n${f.nonce}\n${machineId}\n${keyNow.keyId}`);
    sendNow(c, 'control', 'auth.response', {
      machine_id: machineId, key_id: keyNow.keyId, public_key: keyNow.publicWire, signature,
    }, { re: f.id });
  }

  function onAuthOk(c, f) {
    if (c.state !== 'auth' || !c.challenged) { say('link auth.ok out of order ignored'); return; }
    cancel(c, c.authTimer);
    c.state = 'hello';
    c.session = { expires_at: f.expires_at };
    if (f.machine_id !== machineId) say('link auth.ok names another machine id than the record');
    if (rotation && f.key_id === rotation.keyId) {
      commitRotation();     // the hub committed the new key before the old link dropped
    } else if (f.key_id !== current.keyId) {
      say(`link the hub holds key ${token(f.key_id)}, this machine signed with ${current.keyId}`);
    }
    c.rotate = f.rotate === true;
    startBeat(c, HEARTBEAT_MS);
    try {
      sendNow(c, 'control', 'hello', {
        versions: versions(),
        route_table: routeTable(),
        capabilities: [...CAPABILITIES],
      });
    } catch (e) {
      say(`link hello not built ${errCode(e)}`);
      closeConn(c, 4400);
      return;
    }
    c.helloTimer = after(c, HELLO_ACK_WAIT_MS, () => {
      say('link no hello answer');
      closeConn(c, 4400);
    });
  }

  function beat(c) {
    if (c.closed || c.closing != null) return;
    c.beat += 1;
    const base = {
      machine_id: machineId, beat: c.beat, interval_ms: c.beatMs, connector_now: Math.max(0, Math.floor(now())),
      echo_at: c.lastPingAt,
    };
    let body;
    try { body = heartbeatBody({ ...base }); } catch { body = null; }
    if (!isPlainObject(body)) { say('link heartbeat body failed; minimal body sent'); body = minimalHeartbeat(base); }
    sendNow(c, 'control', 'heartbeat', { beat: body });
  }
  function startBeat(c, ms) {
    if (c.beatTimer != null && c.beatMs === ms) return;
    if (c.beatTimer != null) T.clearInterval(c.beatTimer);
    c.beatMs = ms;
    c.beatTimer = T.setInterval(() => beat(c), ms);
  }

  function setCompat(v) {
    compat = isPlainObject(v) ? v : null;
    const state = compat ? token(compat.state) : '?';
    if (state !== compatLogged) {
      compatLogged = state;
      say(`link compat ${state}`);
    }
    link.emit('compat', compat);
  }

  function onHelloAck(c, f) {
    if (c.state !== 'hello') { say('link hello.ack out of order ignored'); return; }
    cancel(c, c.helloTimer);
    const w = helloAckValues(f);
    if (!w) {
      say('link hello.ack values out of bounds');
      fatal(c, 'bad_frame', f.id);
      return;
    }
    info = {
      protocol: f.protocol,
      hub: isPlainObject(f.hub) ? { ...f.hub } : null,
      machine: isPlainObject(f.machine) ? { ...f.machine } : null,
      capabilities: Array.isArray(f.capabilities) ? [...f.capabilities] : [],
      heartbeatMs: f.heartbeat_ms,
      deadAfterMs: f.dead_after_ms,
      windows: w,
      sessionExpiresAt: c.session ? c.session.expires_at : null,
    };
    c.state = 'up';
    c.wasUp = true;
    needsUpdate = false;
    c.deadAfter = f.dead_after_ms;
    resetDead(c);
    startBeat(c, f.heartbeat_ms);
    after(c, BACKOFF_RESET_MS, () => { attempt = 0; });
    say(`link up protocol ${Number.isInteger(f.protocol) ? f.protocol : '?'}`);
    setCompat(f.compat);
    sendFacts(c);
    if (c.rotate) startRotation(c);
    flush(c);
    link.emit('ready', { ...info });
  }

  function onHelloRefused(c, f) {
    if (c.state !== 'hello') return;
    cancel(c, c.helloTimer);
    needsUpdate = true;
    say('link hello refused: needs update');
    setCompat(f.compat);
  }

  function sendFacts(c) {
    let body;
    try { body = facts(); } catch { body = null; }
    if (!isPlainObject(body)) { say('link machine facts unavailable'); return null; }
    try {
      return sendNow(c, 'control', 'machine.facts', body);
    } catch (e) {
      say(`link machine facts not sent ${errCode(e)}`);
      return null;
    }
  }
  function factsChanged() {
    const c = conn;
    if (c && c.state === 'up') sendFacts(c);
  }

  function onSettingsFrame(c, f) {
    if (c.state !== 'up') { say('link machine.settings before hello.ack ignored'); return; }
    const s = f.settings;
    if (!Number.isInteger(s.rev)) { say('link machine.settings without a rev ignored'); return; }
    if (settingsRev !== null && s.rev < settingsRev) { say(`link machine.settings rev ${s.rev} older than ${settingsRev} ignored`); return; }
    settingsRev = s.rev;
    try {
      const r = onSettings({ ...s });
      if (r && typeof r.then === 'function') r.then(null, () => say('link settings not applied'));
    } catch {
      say('link settings not applied');
    }
    sendFacts(c);
  }

  // ── rotation (C-05.7) ────────────────────────────────────────────────────
  function startRotation(c) {
    if (!rotation) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      rotation = holdKey(privateKey);
      for (const s of keySecrets(privateKey)) secrets.add(s);
    }
    const signed = `${ROTATE_PREFIX}\n${host}\n${machineId}\n${rotation.keyId}`;
    c.rotateId = sendNow(c, 'control', 'key.rotate', {
      new_public_key: rotation.publicWire,
      new_key_id: rotation.keyId,
      sig_old: sign(current.privateKey, signed),
      sig_new: sign(rotation.privateKey, signed),
    });
    say(`link key rotation offered ${rotation.keyId}`);
  }
  function onRotated(c, f) {
    if (!rotation || f.key_id !== rotation.keyId) { say('link key.rotated for no rotation in hand ignored'); return; }
    commitRotation();
  }
  function commitRotation() {
    const next = rotation;
    rotation = null;
    const pem = next.privateKey.export({ type: 'pkcs8', format: 'pem' });
    let written = true;
    try {
      writeKey({ hubId, privateKey: next.privateKey, pem, keyId: next.keyId, publicKey: next.publicWire, fingerprint: next.fingerprint });
    } catch (e) {
      written = false;
      say(`link rotated key not written ${errCode(e)}`);
    }
    current = next;
    say(`link key rotated to ${next.keyId}`);
    link.emit('rotated', { keyId: next.keyId, fingerprint: next.fingerprint, written });
  }

  // ── closing and backoff (C-05.9) ─────────────────────────────────────────
  function onClose(c, wireCode) {
    if (c.closed) return;
    c.closed = true;
    clearConnTimers(c);
    const code = c.closing != null ? c.closing : wireCode;
    if (c === conn) conn = null;
    for (const [id, p] of pending) {
      if (p.conn !== c) continue;
      pending.delete(id);
      T.clearTimeout(p.timer);
      p.reject(linkError('ELINKDOWN', 'the link closed'));
    }
    for (const id of [...c.streams.keys()]) endStream(c, id, 'link_closed');
    if (code === 1009) say(`link closed 1009 (a message above the transport ceiling) machine ${machineId}`);

    let action = closeAction(code);
    let delayMs = null;
    if (stopped) action = 'stop';
    else if (action === 'redial' && c.viaRedial && !c.wasUp) action = 'normal';
    switch (action) {
      case 'stop':
        break;
      case 'revoked':
        ended = 'revoked';
        break;
      case 'superseded':
        ended = 'superseded';
        break;
      case 'redial':
        delayMs = 0;
        break;
      case 'slow':
        delayMs = slowDelay(random);
        break;
      case 'rate':
        delayMs = Math.max(RATE_LIMITED_MIN_MS, backoffDelay(attempt++, random));
        break;
      default:
        action = 'normal';
        delayMs = backoffDelay(attempt++, random);
    }
    nextRetry = { code, action, delayMs };
    say(`link closed ${Number.isInteger(code) ? code : '?'} ${action}${delayMs != null ? ` ${delayMs} ms` : ''}`);
    if (action === 'stop') stopped = true;
    link.emit('closed', { ...nextRetry });
    if (action === 'revoked') {
      say(`link machine ${machineId} revoked; the connector stops`);
      link.emit('revoked', { afterNotice: revokedSeen });
    }
    if (delayMs === 0) dial();
    else if (delayMs != null) retryTimer = T.setTimeout(dial, delayMs);
    if (!conn && !retryTimer) for (const w of stopWaiters.splice(0)) w();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  function start() {
    if (ended) return false;
    stopped = false;
    if (conn || retryTimer) return true;
    dial();
    return true;
  }
  function stop() {
    stopped = true;
    if (retryTimer) { T.clearTimeout(retryTimer); retryTimer = null; }
    const c = conn;
    if (!c) return Promise.resolve();
    const done = new Promise((r) => stopWaiters.push(r));
    if (c.ws && c.ws.readyState === WebSocket.CONNECTING) {
      try { c.ws.terminate(); } catch { onClose(c, 1006); }
    } else {
      closeConn(c, 1000);
    }
    return done;
  }

  Object.defineProperties(link, {
    state: {
      get() {
        if (ended) return ended;
        if (conn) return conn.state;
        if (retryTimer) return 'backoff';
        return stopped ? 'stopped' : 'idle';
      },
    },
    compat: { get() { return compat; } },
    needsUpdate: { get() { return needsUpdate; } },
    info: { get() { return info && conn && conn.state === 'up' ? { ...info } : null; } },
    nextRetry: { get() { return nextRetry && { ...nextRetry }; } },
    keyId: { get() { return current.keyId; } },
    url: { value: url },
    host: { value: host },
  });
  Object.assign(link, {
    start, stop, send, request, channel, registerSecret, factsChanged, batchSlot, signalRoom, streams,
  });
  return link;
}

module.exports = {
  createLink,
  dialUrl,
  closeAction,
  backoffDelay,
  slowDelay,
  minimalHeartbeat,
  CAPABILITIES,
  CLOSE_RULES,
  SIGNAL_KINDS,
  AUTH_PREFIX,
  ROTATE_PREFIX,
  AUTH_WAIT_MS,
  HEARTBEAT_MS,
  DEAD_AFTER_MS,
  BACKOFF_CAP_MS,
  BACKOFF_RESET_MS,
  SLOW_MS,
  RATE_LIMITED_MIN_MS,
  WINDOWS_DEFAULT,
};

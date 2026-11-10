'use strict';

// The connector link's frame rules (contract 05 C-05.10, C-05.11 and A-05.1;
// tranche 6, U716): the envelope, the 1 MiB frame bound, the channels, and the
// INBOUND CHECK — one row per (ch, kind) the hub may send, giving that kind's
// closed top-level key set, its required keys and each key's JSON type.
//
// THE TABLE IS NOT A SCHEMA COPY. The runtime carries no schema file and no
// ajv (ruling U716@inbound-frame-check (a), notes-A question 2). Each row is
// what the locked 05 schema's $def for that kind says about the TOP LEVEL of
// the frame, and test/connector-frames.test.js holds every row EQUAL to the
// locked schemas through test-support/contracts-loader (every property, every
// required key, additionalProperties false, the decision / decision_ref
// choice), so the table cannot drift from a schema without failing the build.
// A nested body (a decision, an assignment, a delivery, a compat verdict, an
// ack) is checked by the module that reads it, failing closed.
//
// A-05.1 (wc-19): a frame of a known (ch, kind) that fails its row is the fatal
// `bad_frame`, both directions; malformed JSON, an unknown channel, an oversize
// frame and a seq jump are fatal too (control.error with fatal, then 4400). An
// unknown kind on a known channel is the non-fatal `unknown_kind`. There is no
// row for a frame that asks the connector to update, restart, run a command or
// replace its code (C-05.15): no such kind exists, so it is unknown_kind.

const FRAME_MAX = 1024 * 1024;            // C-05.10: the encoded frame, never its payload
const MAX_PAYLOAD = 4 * 1024 * 1024;      // A-05.1 C-05.10a: the transport ceiling
const SUBPROTOCOL = 'web-chat-connector'; // C-05.4
const CHANNELS = Object.freeze(['control', 'relay', 'events', 'queue']); // `blobs` is refused in protocol 1
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KIND_RE = /^[a-z]+(\.[a-z_]+){0,3}$/;

// The envelope every frame carries (05-envelope.json): ch, kind, id, seq, and
// re / at when present. Spread into every row.
const ENVELOPE = Object.freeze({ ch: 'string', kind: 'string', id: 'string', seq: 'integer', at: 'integer' });
const ENVELOPE_REQUIRED = Object.freeze(['ch', 'kind', 'id', 'seq']);

function row(keys, required, extra = {}) {
  const allKeys = Object.freeze({ ...ENVELOPE, ...keys });
  return Object.freeze({
    keys: allKeys,
    required: Object.freeze([...ENVELOPE_REQUIRED, ...required]),
    ...(extra.exactlyOne ? { exactlyOne: Object.freeze([...extra.exactlyOne]) } : {}),
  });
}

// A relayed request, a WebSocket open and a delivery carry exactly one of a
// full decision or a reference to one the link already holds (A-04.1).
const ONE_DECISION = { exactlyOne: ['decision', 'decision_ref'] };

// (ch, kind) → the kind's top level, for every kind the hub sends (C-05.5 to
// C-05.43, A-05.3's hub.response). The connector's own kinds (auth.response,
// hello, heartbeat, machine.facts, …) are not here: an inbound one is unknown.
const FRAME_SHAPES = Object.freeze({
  control: Object.freeze({
    'auth.challenge': row({ nonce: 'string', expires_at: 'integer' }, ['nonce', 'expires_at']),
    'auth.ok': row(
      { re: 'string', machine_id: 'string', connection: 'string', expires_at: 'integer', key_id: 'string', rotate: 'boolean' },
      ['re', 'machine_id', 'connection', 'expires_at', 'key_id'],
    ),
    'auth.refused': row({ re: 'string', reason: 'string', hint: 'string' }, ['reason']),
    'key.rotated': row({ re: 'string', key_id: 'string' }, ['re', 'key_id']),
    'hello.ack': row(
      {
        re: 'string', protocol: 'integer', hub: 'object', machine: 'object', capabilities: 'array',
        heartbeat_ms: 'integer', dead_after_ms: 'integer', windows: 'object', compat: 'object',
      },
      ['re', 'protocol', 'hub', 'machine', 'capabilities', 'heartbeat_ms', 'dead_after_ms', 'windows', 'compat'],
    ),
    'hello.refused': row({ re: 'string', compat: 'object' }, ['re', 'compat']),
    'compat.update': row({ compat: 'object' }, ['compat']),
    ping: row({}, ['at']),
    'control.error': row({ re: 'string', code: 'string', fatal: 'boolean', hint: 'string' }, ['code', 'fatal']),
    'machine.settings': row({ settings: 'object' }, ['settings']),
    'machine.revoked': row({ hint: 'string' }, []),
    'chat.assign': row({ assignment: 'object', cursor: 'object' }, ['assignment', 'cursor']),
    'hub.response': row({ re: 'string', response: 'object' }, ['re', 'response']),
  }),
  relay: Object.freeze({
    'relay.decision': row({ chat: 'string', decision: 'object' }, ['chat', 'decision']),
    'relay.http.request': row(
      {
        stream: 'integer', chat: 'string', surface: 'string', method: 'string', path: 'string', headers: 'object',
        actor: 'object', decision: 'object', decision_ref: 'object', device: 'string', body: 'string', end: 'boolean',
      },
      ['stream', 'chat', 'surface', 'method', 'path', 'headers', 'actor', 'end'],
      ONE_DECISION,
    ),
    'relay.http.body': row({ stream: 'integer', body: 'string', end: 'boolean' }, ['stream', 'body', 'end']),
    'relay.http.abort': row({ stream: 'integer', reason: 'string' }, ['stream', 'reason']),
    'relay.window': row({ stream: 'integer', bytes: 'integer' }, ['stream', 'bytes']),
    'relay.ws.open': row(
      {
        stream: 'integer', chat: 'string', path: 'string', user_agent: 'string', actor: 'object',
        decision: 'object', decision_ref: 'object', device: 'string',
      },
      ['stream', 'chat', 'path', 'actor'],
      ONE_DECISION,
    ),
    'relay.ws.data': row({ stream: 'integer', binary: 'boolean', more: 'boolean', data: 'string' }, ['stream', 'binary', 'data']),
    'relay.ws.close': row({ stream: 'integer', code: 'integer', reason: 'string' }, ['stream', 'code']),
  }),
  events: Object.freeze({
    'events.ack': row({ re: 'string', ack: 'object' }, ['re', 'ack']),
    'signals.ack': row({ up_to: 'integer' }, ['up_to']),
  }),
  queue: Object.freeze({
    'queue.deliver': row(
      { delivery: 'object', actor: 'object', decision: 'object', decision_ref: 'object', device: 'string' },
      ['delivery', 'actor'],
      ONE_DECISION,
    ),
  }),
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function jsonTypeIs(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return isPlainObject(v);
    case 'array': return Array.isArray(v);
    case 'null': return v === null;
    default: return false;
  }
}

// The row for (ch, kind), or null.
function shapeOf(ch, kind) {
  if (typeof ch !== 'string' || typeof kind !== 'string') return null;
  const byKind = has(FRAME_SHAPES, ch) ? FRAME_SHAPES[ch] : null;
  return byKind && has(byKind, kind) ? byKind[kind] : null;
}

// Check a parsed frame against its row. → { ok: true } or { ok: false, why }
// where `why` names the rule and the key (never the value).
function checkShape(frame, shape = frame && shapeOf(frame.ch, frame.kind)) {
  if (!isPlainObject(frame)) return { ok: false, why: 'not an object' };
  if (!shape) return { ok: false, why: 'no row' };
  for (const key of Object.keys(frame)) {
    if (!has(shape.keys, key)) return { ok: false, why: `extra key ${safeKey(key)}` };
    const t = shape.keys[key];
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((x) => jsonTypeIs(x, frame[key]))) return { ok: false, why: `${safeKey(key)} is not ${types.join('|')}` };
  }
  for (const key of shape.required) if (!has(frame, key)) return { ok: false, why: `missing ${key}` };
  if (shape.exactlyOne) {
    const n = shape.exactlyOne.filter((k) => has(frame, k)).length;
    if (n !== 1) return { ok: false, why: `not exactly one of ${shape.exactlyOne.join(', ')}` };
  }
  if (!ID_RE.test(frame.id)) return { ok: false, why: 'id' };
  if (has(frame, 're') && !ID_RE.test(frame.re)) return { ok: false, why: 're' };
  if (frame.seq < 1) return { ok: false, why: 'seq' };
  if (has(frame, 'at') && frame.at < 0) return { ok: false, why: 'at' };
  return { ok: true };
}

// A key named in a reason is the hub's text; keep it to the envelope grammar.
function safeKey(key) {
  return /^[a-z_]{1,40}$/.test(key) ? key : '?';
}

// Read one inbound message, in C-05.10's order. → one of
//   { fatal: code, re }      the link answers control.error fatal, then 4400
//   { unknown: true, frame } a known channel, a kind with no row: non-fatal
//   { frame }                checked against its row
// `expectSeq(ch)` returns the seq this channel must carry next; `takeSeq(ch,
// seq)` records it (the seq is counted before the kind is looked at, so an
// unknown kind still advances it).
function readFrame(data, isBinary, { expectSeq, takeSeq }) {
  if (isBinary) return { fatal: 'bad_frame', re: null };
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  if (Buffer.byteLength(text) > FRAME_MAX) return { fatal: 'too_large', re: null };
  let frame;
  try { frame = JSON.parse(text); } catch { return { fatal: 'bad_frame', re: null }; }
  if (!isPlainObject(frame)) return { fatal: 'bad_frame', re: null };
  const re = typeof frame.id === 'string' && ID_RE.test(frame.id) ? frame.id : null;
  if (typeof frame.ch !== 'string' || !CHANNELS.includes(frame.ch)) return { fatal: 'unknown_channel', re };
  if (!re || !Number.isInteger(frame.seq) || typeof frame.kind !== 'string' || !KIND_RE.test(frame.kind)) {
    return { fatal: 'bad_frame', re };
  }
  if (frame.seq !== expectSeq(frame.ch)) return { fatal: 'seq_gap', re };
  takeSeq(frame.ch, frame.seq);
  const shape = shapeOf(frame.ch, frame.kind);
  if (!shape) return { unknown: true, frame, re };
  const v = checkShape(frame, shape);
  if (!v.ok) return { fatal: 'bad_frame', re, why: v.why };
  return { frame, re };
}

module.exports = {
  FRAME_SHAPES,
  FRAME_MAX,
  MAX_PAYLOAD,
  SUBPROTOCOL,
  CHANNELS,
  ID_RE,
  KIND_RE,
  shapeOf,
  checkShape,
  readFrame,
};

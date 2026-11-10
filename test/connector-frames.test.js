'use strict';

// lib/connector/frames.js (tranche 6, U716): FRAME_SHAPES is held EQUAL to the
// locked contract-05 schemas (the v1.4 lock, every locked amendment folder in
// lock order, through test-support/contracts-loader), so the runtime table —
// which carries no schema and no ajv — cannot drift from a schema without this
// file failing (ruling U716@inbound-frame-check (a)).

const test = require('node:test');
const assert = require('node:assert');
const { createValidator } = require('../test-support/contracts-loader');
const {
  FRAME_SHAPES, FRAME_MAX, CHANNELS, shapeOf, checkShape, readFrame,
} = require('../lib/connector/frames');

const validator = createValidator({ folders: 'all' });
const clone = (v) => JSON.parse(JSON.stringify(v));

// The kinds the hub may send (the brief's list, 05 §3.2–§3.10 and A-05.3).
const INBOUND = [
  ['control', 'auth.challenge'], ['control', 'auth.ok'], ['control', 'auth.refused'], ['control', 'key.rotated'],
  ['control', 'hello.ack'], ['control', 'hello.refused'], ['control', 'compat.update'], ['control', 'ping'],
  ['control', 'control.error'], ['control', 'machine.settings'], ['control', 'machine.revoked'],
  ['control', 'chat.assign'], ['control', 'hub.response'],
  ['relay', 'relay.decision'], ['relay', 'relay.http.request'], ['relay', 'relay.http.body'],
  ['relay', 'relay.http.abort'], ['relay', 'relay.window'], ['relay', 'relay.ws.open'], ['relay', 'relay.ws.data'],
  ['relay', 'relay.ws.close'],
  ['events', 'events.ack'], ['events', 'signals.ack'],
  ['queue', 'queue.deliver'],
];

const rows = () => Object.entries(FRAME_SHAPES).flatMap(([ch, kinds]) => Object.keys(kinds).map((kind) => [ch, kind]));

// ── the schema side ─────────────────────────────────────────────────────────
function resolveRef(ref, baseId) {
  const abs = new URL(ref, baseId).href;
  const v = validator.ajv.getSchema(abs);
  assert.ok(v, `no schema at ${abs}`);
  return { schema: v.schema, base: abs.split('#')[0] };
}
const jsonTypeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const norm = (t) => {
  const list = [...new Set(Array.isArray(t) ? t : [t])].sort();
  return list.length === 1 ? list[0] : list;
};
// The JSON type(s) one property admits at the top level of a frame.
function typeOfSchema(s, base) {
  if (s.const !== undefined) return jsonTypeOf(s.const);
  if (s.type !== undefined) return norm(s.type);
  if (s.$ref) {
    const r = resolveRef(s.$ref, base);
    return typeOfSchema(r.schema, r.base);
  }
  const branches = s.oneOf || s.anyOf;
  if (branches) return norm(branches.flatMap((b) => [].concat(typeOfSchema(b, base))));
  if (s.enum) return norm(s.enum.map(jsonTypeOf));
  throw new Error(`no type for ${JSON.stringify(s).slice(0, 80)}`);
}
function defOf(ch, kind) {
  const entry = validator.frameIndex.get(`${ch}\u0000${kind}`);
  assert.ok(entry, `(${ch}, ${kind}) has no locked 05 schema def`);
  const schema = validator.view.schemas.get(entry.schema).data;
  return { def: schema.$defs[entry.def], base: schema.$id, entry };
}

test('FRAME_SHAPES lists exactly the kinds the hub sends, and none of the connector\'s own', () => {
  const have = rows().map(([ch, kind]) => `${ch} ${kind}`).sort();
  const want = INBOUND.map(([ch, kind]) => `${ch} ${kind}`).sort();
  assert.deepStrictEqual(have, want);
  for (const kind of ['auth.response', 'hello', 'heartbeat', 'machine.facts', 'key.rotate', 'hub.request', 'queue.ack', 'events.batch']) {
    assert.strictEqual(rows().some(([, k]) => k === kind), false, `${kind} is the connector's to send`);
  }
  assert.deepStrictEqual([...CHANNELS], ['control', 'relay', 'events', 'queue'], 'blobs is refused in protocol 1');
});

test('FRAME_SHAPES equals the locked schemas: every key, its type, every required key, closed, the decision choice', () => {
  for (const [ch, kind] of rows()) {
    const shape = FRAME_SHAPES[ch][kind];
    const { def, base, entry } = defOf(ch, kind);
    const where = `${ch} ${kind} (${entry.schema}#${entry.def})`;
    assert.strictEqual(def.additionalProperties, false, `${where} is closed`);
    assert.strictEqual(def.properties.ch.const, ch, where);
    assert.strictEqual(def.properties.kind.const, kind, where);
    assert.deepStrictEqual(Object.keys(shape.keys).sort(), Object.keys(def.properties).sort(), `${where}: the key set`);
    for (const [key, sub] of Object.entries(def.properties)) {
      assert.deepStrictEqual(norm(shape.keys[key]), typeOfSchema(sub, base), `${where}: ${key}'s type`);
    }
    assert.deepStrictEqual([...shape.required].sort(), [...def.required].sort(), `${where}: required`);
    if (def.oneOf) {
      const one = def.oneOf.map((b) => {
        assert.deepStrictEqual(Object.keys(b), ['required'], `${where}: a oneOf branch is a required list alone`);
        assert.strictEqual(b.required.length, 1, where);
        return b.required[0];
      }).sort();
      assert.deepStrictEqual([...(shape.exactlyOne || [])].sort(), one, `${where}: exactly one of`);
    } else {
      assert.strictEqual(shape.exactlyOne, undefined, `${where}: no choice the schema does not make`);
    }
    for (const k of ['allOf', 'anyOf', 'if', 'not', 'dependentRequired', 'patternProperties']) {
      assert.strictEqual(def[k], undefined, `${where}: ${k} at the top level would be a rule the table does not hold`);
    }
  }
});

// A sample of every inbound kind: each locked example of it, else one built
// here and proved valid against the lock first.
function samples() {
  const out = new Map(INBOUND.map(([ch, kind]) => [`${ch} ${kind}`, []]));
  for (const [name, ex] of validator.view.examples) {
    for (const f of [].concat(ex.data)) {
      if (f && typeof f === 'object' && out.has(`${f.ch} ${f.kind}`)) out.get(`${f.ch} ${f.kind}`).push({ name, frame: clone(f) });
    }
  }
  const ack = validator.view.examples.get('05-hello.ack').data;
  const built = {
    'control key.rotated': { ch: 'control', kind: 'key.rotated', id: 'h9', seq: 9, re: 'c9', at: 1, key_id: 'mky_v6men077h4s9p7hvxfv5etvn01' },
    'control compat.update': { ch: 'control', kind: 'compat.update', id: 'h10', seq: 10, at: 1, compat: clone(ack.compat) },
    'relay relay.http.body': { ch: 'relay', kind: 'relay.http.body', id: 'h11', seq: 4, at: 1, stream: 7, body: 'aGVsbG8=', end: true },
  };
  for (const [key, frame] of Object.entries(built)) {
    if (!out.get(key).length) out.get(key).push({ name: `built ${key}`, frame });
  }
  return out;
}

test('every locked example of an inbound kind passes the check (and ajv)', () => {
  const all = samples();
  for (const [key, list] of all) {
    assert.ok(list.length, `${key} has a sample`);
    for (const { name, frame } of list) {
      const v = validator.validateFrame(frame);
      assert.ok(v.ok, `${name}: ajv ${JSON.stringify(v.errors)}`);
      assert.deepStrictEqual(checkShape(frame), { ok: true }, name);
    }
  }
});

const WRONG = { string: 42, integer: 'x', boolean: 'x', object: 'x', array: 'x', number: 'x' };
const ENVELOPE = new Set(['ch', 'kind', 'id', 'seq', 're', 'at']);

test('a missing required key, an extra top-level key and a wrong top-level type each fail both ajv and the check', () => {
  for (const [key, list] of samples()) {
    const [ch, kind] = key.split(' ');
    const shape = shapeOf(ch, kind);
    for (const { name, frame } of list) {
      const req = shape.required.find((k) => !ENVELOPE.has(k)) || 'id';
      const missing = clone(frame);
      delete missing[req];
      const extra = { ...clone(frame), zz_extra: 1 };
      const typed = Object.keys(frame).find((k) => !ENVELOPE.has(k)) || 'seq';
      const t = [].concat(shape.keys[typed])[0];
      const wrong = { ...clone(frame), [typed]: WRONG[t] };
      for (const [what, bad] of [[`missing ${req}`, missing], ['extra key', extra], [`${typed} as the wrong type`, wrong]]) {
        assert.strictEqual(validator.validateFrame(bad).ok, false, `${name} ${what}: ajv refuses`);
        assert.strictEqual(checkShape(bad).ok, false, `${name} ${what}: the check refuses`);
      }
    }
  }
});

test('a relayed request, a WebSocket open and a delivery carry exactly one of decision and decision_ref', () => {
  for (const name of ['05-relay-http', '05-relay-ws', '05-queue-deliver']) {
    const f = clone(validator.view.examples.get(name).data);
    const both = { ...f, decision: f.decision || {}, decision_ref: f.decision_ref || {} };
    const neither = clone(f);
    delete neither.decision;
    delete neither.decision_ref;
    for (const bad of [both, neither]) {
      assert.strictEqual(validator.validateFrame(bad).ok, false, name);
      assert.strictEqual(checkShape(bad).ok, false, name);
    }
  }
});

// ── readFrame: C-05.10's order ──────────────────────────────────────────────
function reader(start = {}) {
  const seq = { ...start };
  return {
    seq,
    io: { expectSeq: (ch) => (seq[ch] || 0) + 1, takeSeq: (ch, n) => { seq[ch] = n; } },
  };
}
const ping = (over = {}) => JSON.stringify({ ch: 'control', kind: 'ping', id: 'h1', seq: 1, at: 5, ...over });

test('readFrame: binary, oversize, malformed, unknown channel, seq jump and bad shape are fatal; an unknown kind is not', () => {
  assert.deepStrictEqual(readFrame(Buffer.from('{}'), true, reader().io), { fatal: 'bad_frame', re: null });
  const big = JSON.stringify({ ch: 'control', kind: 'control.error', id: 'h1', seq: 1, code: 'internal', fatal: false, hint: 'x'.repeat(FRAME_MAX) });
  assert.strictEqual(readFrame(big, false, reader().io).fatal, 'too_large');
  assert.strictEqual(readFrame('{nope', false, reader().io).fatal, 'bad_frame');
  assert.strictEqual(readFrame('[1,2]', false, reader().io).fatal, 'bad_frame');
  assert.deepStrictEqual(readFrame(JSON.stringify({ ch: 'blobs', kind: 'blob.put', id: 'h1', seq: 1 }), false, reader().io), { fatal: 'unknown_channel', re: 'h1' });
  assert.deepStrictEqual(readFrame(ping({ seq: 3 }), false, reader().io), { fatal: 'seq_gap', re: 'h1' });
  const r = reader();
  const bad = readFrame(ping({ extra: true }), false, r.io);
  assert.strictEqual(bad.fatal, 'bad_frame');
  assert.strictEqual(bad.re, 'h1');
  assert.doesNotMatch(String(bad.why), /true/, 'a reason names the rule, never the value');

  const u = reader();
  const unknown = readFrame(JSON.stringify({ ch: 'control', kind: 'connector.update', id: 'h2', seq: 1, url: 'https://x' }), false, u.io);
  assert.strictEqual(unknown.unknown, true);
  assert.strictEqual(u.seq.control, 1, 'an unknown kind still counts its seq');
  assert.ok(readFrame(ping({ seq: 2, id: 'h3' }), false, u.io).frame, 'and the next frame reads on');

  const ok = readFrame(ping(), false, reader().io);
  assert.strictEqual(ok.frame.kind, 'ping');
  assert.strictEqual(ok.fatal, undefined);
});

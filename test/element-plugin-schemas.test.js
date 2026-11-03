// Plug-in schema rows (annotation engine tranche 4, 4A.2; U513): the element
// log's registerSchema / schemaRow beside the frozen built-in SCHEMAS, the one
// generic bound over every plug-in payload, the plug-in id letter p (RULED
// U513@id-letter a), the scanner's [chgkp] class, a chain naming a p id, and
// payloadDeclProblem — element.json's `payload: {keys, max_bytes?}` check
// (RULED U513-U565@payload-decl a). lib/core/element-log.js.
//
// The plug-in table is process-wide and never unregisters, so every test here
// registers its own type names (tq-…); test files run in their own processes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const el = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { stableStringify } = require('../lib/core/stable-json');
const { projectPaths } = require('../lib/core/paths');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');

const {
  createElementLog, payloadOf, maxElementSeqIn, SCHEMAS, ID_PREFIX, CHAIN_SCHEMA, typeOfId,
  registerSchema, schemaRow, schemaNames, isPluginType, isTypedId, payloadDeclProblem, PLUGIN_ID_LETTER,
  PLUGIN_STRING_MAX, PLUGIN_ARRAY_MAX, PLUGIN_TUPLE_MAX, PLUGIN_PAYLOAD_MAX, PLUGIN_META_MAX, PLUGIN_KEYS_MAX,
  PLUGIN_META_KEY, PLUGIN_REQUIRED_KEYS,
} = el;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-element-plugin-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}
function openIn(t, dir, opts = {}) {
  const file = projectPaths(dir).elementsLog;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const log = createElementLog({ file, redactor: opts.redactor || createRedactor() });
  t.after(() => log.close());
  log.load();
  return log;
}

const RANGE = { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'quick brown', prefix: 'The ', suffix: ' fox' }, ordinal: 0 };
const TURN_ANCHOR = {
  v: 1, kind: 'turn', conversation_id: 'conv-1', session_id: 'sess-1', turn_id: 't1',
  quote: { exact: 'hello' }, marks: 0, label: 'turn 1', fp: { h: '0123456789abcdef', len: 5 },
};
const INK_KEYS = ['anchor', 'shared', 'points', 'color', 'width', 'tool'];
const stroke = (n) => Array.from({ length: n }, (_, i) => [100.25 + i, 200.5 + i / 2, 0.5, 1730000000000 + i * 8]);
const inkPayload = (over = {}) => ({ anchor: RANGE, shared: false, points: stroke(3), color: '#c03', width: 2.5, tool: 'pen', ...over });

const fails = (fn, re, what) => assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message), what);

// ── the constants ───────────────────────────────────────────────────────────

test('the generic bound\'s limits are exported constants, as ruled', () => {
  assert.equal(PLUGIN_STRING_MAX, 2000);
  assert.equal(PLUGIN_ARRAY_MAX, 4096);
  assert.equal(PLUGIN_TUPLE_MAX, 8);
  assert.equal(PLUGIN_PAYLOAD_MAX, 65536);
  assert.equal(PLUGIN_META_MAX, 32);
  assert.equal(PLUGIN_KEYS_MAX, 24);
  assert.equal(PLUGIN_META_KEY, 'meta');
  assert.deepEqual([...PLUGIN_REQUIRED_KEYS], ['anchor', 'shared']);
  assert.equal(PLUGIN_ID_LETTER, 'p');
  assert.ok(!Object.values(ID_PREFIX).includes(PLUGIN_ID_LETTER), 'the plug-in letter is not a built-in\'s');
});

// ── registerSchema ──────────────────────────────────────────────────────────

test('registerSchema: a registration is a frozen row (declared keys + meta), and an equal repeat is idempotent', () => {
  const row = registerSchema('tq-ink@1', { type: 'tq-ink', keys: INK_KEYS });
  assert.ok(Object.isFrozen(row));
  assert.ok(Object.isFrozen(row.keys));
  assert.equal(row.type, 'tq-ink');
  assert.equal(row.plugin, true);
  assert.equal(row.maxBytes, PLUGIN_PAYLOAD_MAX);
  assert.deepEqual([...row.keys], [...INK_KEYS, 'meta']);
  assert.equal(typeof row.check, 'function');
  assert.strictEqual(registerSchema('tq-ink@1', { type: 'tq-ink', keys: INK_KEYS }), row, 'the same row');
  assert.strictEqual(registerSchema('tq-ink@1', { type: 'tq-ink', keys: [...INK_KEYS].reverse() }), row, 'key order is not a difference');
  assert.strictEqual(schemaRow('tq-ink@1'), row);
  assert.ok(isPluginType('tq-ink'));
  assert.ok(!isPluginType('comment'));
  assert.ok(!isPluginType('tq-never'));
  assert.ok(schemaNames().includes('tq-ink@1'));
  assert.deepEqual(schemaNames().slice(0, Object.keys(SCHEMAS).length), Object.keys(SCHEMAS), 'the built-ins first, in table order');
  // A built-in name reads SCHEMAS' own row.
  for (const s of Object.keys(SCHEMAS)) assert.strictEqual(schemaRow(s), SCHEMAS[s]);
  // A new key set takes a new @n; the old row stays.
  const two = registerSchema('tq-ink@2', { type: 'tq-ink', keys: [...INK_KEYS, 'label'], maxBytes: 4096 });
  assert.equal(two.maxBytes, 4096);
  assert.strictEqual(schemaRow('tq-ink@1'), row);
});

test('registerSchema refuses a built-in schema name, a built-in type, another type\'s name, keys without anchor or shared, and the same name with other keys', () => {
  registerSchema('tq-mark@1', { type: 'tq-mark', keys: ['anchor', 'shared', 'note'] });
  fails(() => registerSchema(Object.keys(SCHEMAS)[0], { type: 'comment', keys: ['anchor', 'shared'] }), /is a built-in schema/, 'a built-in schema name');
  for (const type of ['comment', 'highlight', 'box-grab', 'chat-comment']) {
    fails(() => registerSchema(`${type}@9`, { type, keys: ['anchor', 'shared'] }), /is a built-in type/, `the built-in type ${type}`);
  }
  fails(() => registerSchema('tq-other@1', { type: 'tq-mine', keys: ['anchor', 'shared'] }), /"tq-mine@<n>"/, 'a name of another type');
  for (const bad of ['tq-mine', 'tq-mine@0', 'tq-mine@x', '@1']) {
    fails(() => registerSchema(bad, { type: 'tq-mine', keys: ['anchor', 'shared'] }), /"tq-mine@<n>"/, `the name ${bad}`);
  }
  fails(() => registerSchema('tq-mine@1', { type: 'tq-mine', keys: ['shared', 'note'] }), /missing anchor/, 'no anchor');
  fails(() => registerSchema('tq-mine@1', { type: 'tq-mine', keys: ['anchor', 'note'] }), /missing shared/, 'no shared');
  fails(() => registerSchema('tq-mine@1', { type: 'tq-mine', keys: ['anchor', 'shared', 'meta'] }), /never names meta/, 'meta declared');
  fails(() => registerSchema('tq-mark@1', { type: 'tq-mark', keys: ['anchor', 'shared', 'note', 'color'] }), /other keys/, 'the same name, other keys');
  fails(() => registerSchema('tq-mark@1', { type: 'tq-mark', keys: ['anchor', 'shared', 'note'], maxBytes: 100 }), /other keys or another bound/, 'the same name, another bound');
  assert.ok(!isPluginType('tq-mine'), 'a refusal registers nothing');
  assert.equal(schemaRow('tq-mine@1'), null);
});

test('schemaRow: own-property reads only — toString, __proto__, a non-string and an unknown name are null', () => {
  for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty', '', 'tq-none@1', null, undefined, 7, {}]) {
    assert.strictEqual(schemaRow(name), null, String(name));
  }
});

// ── the log writes a plug-in type ───────────────────────────────────────────

test('a registered row appends through appendVersion; mintId mints p<seq> over the one counter (c1, p2, h3)', (t) => {
  registerSchema('tq-pen@1', { type: 'tq-pen', keys: INK_KEYS });
  const log = openIn(t, tmpDir(t));
  const c = log.mintId('comment');
  const p = log.mintId('tq-pen');
  const h = log.mintId('highlight');
  assert.deepEqual([c, p, h], ['c1', 'p2', 'h3']);
  assert.equal(typeOfId(p), null, 'the letter names no type');
  assert.ok(isTypedId(p));
  log.ensureElement({ id: p, kind: 'tq-pen', created_at: 1 });
  const rec = log.appendVersion({ id: p, schema: 'tq-pen@1', payload: inkPayload(), at: 2 });
  assert.equal(rec.v, 1);
  assert.equal(rec.seq, 2, 'the id\'s first version takes its seq');
  assert.equal(rec.schema, 'tq-pen@1');
  assert.deepEqual(rec.payload, inkPayload());
  const v2 = log.appendVersion({ id: p, schema: 'tq-pen@1', payload: inkPayload({ color: '#03c' }), parent_v: 1, at: 3 });
  assert.equal(v2.v, 2);
  assert.equal(log.mintId('tq-pen'), 'p5', 'the next seq, whatever the type');
  // A mint for a type no row names, a built-in schema on a p id, a plug-in
  // schema on a built-in id or on an id with no el record: refused.
  fails(() => log.mintId('tq-unregistered'), /registered plug-in type/, 'an unregistered type mints nothing');
  fails(() => log.appendVersion({ id: p, schema: Object.keys(SCHEMAS)[1], payload: { anchor: null, shared: true, color: 'x', note: '' }, at: 4 }), /is a tq-pen/, 'a highlight schema on a pen');
  fails(() => log.appendVersion({ id: 'c1', schema: 'tq-pen@1', payload: inkPayload(), at: 4 }), /is a comment/, 'a pen schema on a comment id');
  fails(() => log.appendVersion({ id: 'p9', schema: 'tq-pen@1', payload: inkPayload(), at: 4 }), /no element record naming its type/, 'a p id with no el record');
  log.ensureElement({ id: 'p10', kind: 'tq-pen', created_at: 1 });
  fails(() => log.appendVersion({ id: 'p10', schema: Object.keys(SCHEMAS)[1], payload: { anchor: null, shared: true, color: 'x', note: '' }, at: 4 }), /is a tq-pen/);
  log.ensureElement({ id: 'p11', kind: 'highlight', created_at: 1 });
  fails(() => log.appendVersion({ id: 'p11', schema: Object.keys(SCHEMAS)[1], payload: { anchor: null, shared: true, color: 'x', note: '' }, at: 4 }), /plug-in element's id/, 'a p id takes a plug-in row only');
});

test('an unregistered plug-in schema is refused \'unknown schema\', naming it; nothing lands', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  log.ensureElement({ id: 'p1', kind: 'tq-ghost', created_at: 1 });
  for (const schema of ['tq-ghost@1', 'tq-pen@7']) {
    fails(() => log.appendVersion({ id: 'p1', schema, payload: { anchor: null, shared: true }, at: 1 }),
      new RegExp(`unknown schema ${JSON.stringify(schema)}`), schema);
  }
  assert.equal(log.versionsOf('p1').length, 0);
});

test('the built-in rows\' hashes of fixed payloads are unchanged (pinned from 503b8f2f)', (t) => {
  const log = openIn(t, tmpDir(t));
  const [COMMENT, HIGHLIGHT, BOX_GRAB] = Object.keys(SCHEMAS);
  const pinned = [
    ['c1', COMMENT, payloadOf({ text: 'hello', shared: true, anchor: null }), '45f032d4e4e0dbe18bb187d2d00c952b62187417'],
    ['h2', HIGHLIGHT, { anchor: RANGE, shared: true, color: 'gold', note: 'look here' }, 'd605faf8881cd37b5fc6ebc3f85fd39c7f4bbaa7'],
    ['g3', BOX_GRAB, { anchor: null, shared: true, rect: { x: 1, y: 2, w: 3, h: 4, item: 'm1', viewport: { w: 10, h: 20 } }, meta: {}, grab: null }, '1cea659c56090051dc76bf3f692a8eba4ceff391'],
    ['c4', CHAIN_SCHEMA, payloadOf({ text: 'chained', shared: false, anchor: null, chain: ['h2'] }), '4dcb6e0febf8e5a5bdd61e1360f5143209ef90d8'],
  ];
  for (const [id, schema, payload, hash] of pinned) {
    const r = log.appendVersion({ id, schema, payload, at: 1 });
    assert.equal(r.payload_hash, hash, schema);
    assert.equal(r.src_hash, hash, schema);
  }
});

// ── the generic bound ───────────────────────────────────────────────────────

test('the bound refuses an over-size payload, a nested object, a long string, a long array, a long tuple, a chat anchor and a stray key; meta of 33 keys', (t) => {
  registerSchema('tq-wide@1', { type: 'tq-wide', keys: ['anchor', 'shared', 'a', 's', 'o', 'n', 'b', 'z'] });
  registerSchema('tq-small@1', { type: 'tq-small', keys: ['anchor', 'shared', 's'], maxBytes: 100 });
  const log = openIn(t, tmpDir(t));
  log.ensureElement({ id: 'p1', kind: 'tq-wide', created_at: 1 });
  log.ensureElement({ id: 'p2', kind: 'tq-small', created_at: 1 });
  const put = (payload, id = 'p1', schema = 'tq-wide@1') => log.appendVersion({ id, schema, payload, at: 1 });
  const base = { anchor: null, shared: true };
  const refused = (payload, re, what, id, schema) => assert.throws(() => put(payload, id, schema),
    (e) => e instanceof TypeError && e.reason === 'payload' && re.test(e.message), what);

  // The size: exactly PLUGIN_PAYLOAD_MAX passes, one byte more is refused.
  const sized = (bytes) => {
    const p = { ...base, a: Array(4000).fill(123456789012345), s: '' };
    p.s = 'x'.repeat(bytes - Buffer.byteLength(stableStringify(p)));
    assert.equal(Buffer.byteLength(stableStringify(p)), bytes);
    return p;
  };
  refused(sized(PLUGIN_PAYLOAD_MAX + 1), /size is at most 65536 bytes/, '65,537 bytes');
  assert.equal(put(sized(PLUGIN_PAYLOAD_MAX)).v, 1, '65,536 bytes');
  refused({ ...base, s: 'x'.repeat(100) }, /size is at most 100 bytes/, 'a declared max_bytes', 'p2', 'tq-small@1');

  refused({ ...base, o: { x: 1 } }, /o is null, a boolean/, 'a nested object outside meta');
  refused({ ...base, o: [{ x: 1 }] }, /never a mix, never an object/, 'a list of objects');
  refused({ ...base, o: [1, [2, 3]] }, /never a mix/, 'a mixed list');
  refused({ ...base, s: 'x'.repeat(PLUGIN_STRING_MAX + 1) }, /s is a string of at most 2000 characters/, '2,001 characters');
  refused({ ...base, a: Array(PLUGIN_ARRAY_MAX + 1).fill(1) }, /a holds at most 4096 entries/, '4,097 numbers');
  refused({ ...base, a: Array(PLUGIN_ARRAY_MAX + 1).fill([1, 2]) }, /a holds at most 4096 entries/, '4,097 tuples');
  refused({ ...base, a: [[1, 2, 3, 4, 5, 6, 7, 8, 9]] }, /tuples of at most 8 numbers/, 'a 9-number tuple');
  refused({ ...base, n: Infinity }, /n is null/, 'a non-finite number');
  refused({ ...base, a: [1, NaN] }, /never a mix/, 'a non-finite entry');
  refused({ anchor: TURN_ANCHOR, shared: true }, /anchor is an engine anchor record of a page kind/, 'a chat anchor');
  refused({ anchor: { mount: 'm1', selector: 'p', text: 'x' }, shared: true }, /anchor is an engine anchor record/, 'a legacy locator');
  refused({ anchor: null, shared: 'yes' }, /shared is true or false/, 'shared not a boolean');
  refused({ shared: true }, /anchor is required/, 'no anchor');
  refused({ anchor: null }, /shared is required/, 'no shared');
  refused({ ...base, meta: Object.fromEntries(Array.from({ length: PLUGIN_META_MAX + 1 }, (_, i) => [`k${i}`, i])) }, /meta holds at most 32 keys/, 'meta of 33 keys');
  refused({ ...base, meta: { deep: { x: 1 } } }, /meta\.deep is null/, 'meta nested');
  refused({ ...base, meta: [1] }, /meta is a flat object/, 'meta a list');
  assert.throws(() => put({ ...base, stray: 1 }), (e) => e instanceof TypeError && /holds only anchor, shared, a, s, o, n, b, z, meta, not stray/.test(e.message), 'a stray key');

  // Accepted: every value kind, meta of 32 scalar keys, a page anchor.
  const okay = put({
    anchor: RANGE, shared: false, a: [1, 2.5, -3], s: 'x'.repeat(PLUGIN_STRING_MAX), o: null, n: 0, b: true, z: [[1, 2, 3, 4, 5, 6, 7, 8]],
    meta: Object.fromEntries(Array.from({ length: PLUGIN_META_MAX }, (_, i) => [`k${i}`, i % 2 ? 'v' : i])),
  });
  assert.ok(okay.v >= 1);
  assert.equal(log.versionsOf('p2').length, 0, 'a refused write lands nothing');
});

test('a 1,200-point stroke is accepted under the bound', (t) => {
  registerSchema('tq-stroke@1', { type: 'tq-stroke', keys: INK_KEYS });
  const log = openIn(t, tmpDir(t));
  const id = log.mintId('tq-stroke');
  log.ensureElement({ id, kind: 'tq-stroke', created_at: 1 });
  const payload = inkPayload({ points: stroke(1200) });
  assert.ok(Buffer.byteLength(stableStringify(payload)) < PLUGIN_PAYLOAD_MAX);
  const rec = log.appendVersion({ id, schema: 'tq-stroke@1', payload, at: 1 });
  assert.equal(rec.payload.points.length, 1200);
  assert.deepEqual(rec.payload.points[1199], stroke(1200)[1199]);
});

test('every string of a plug-in payload passes the writer\'s redactor (values and meta); nothing reaches the file', (t) => {
  registerSchema('tq-secret@1', { type: 'tq-secret', keys: ['anchor', 'shared', 'label', 'note'] });
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const fakes = fakeSecrets({ seed: 0x513 }).filter((f) => !f.context && !f.known && f.text.length <= PLUGIN_STRING_MAX).slice(0, 3);
  assert.equal(fakes.length, 3);
  log.ensureElement({ id: 'p1', kind: 'tq-secret', created_at: 1 });
  const rec = log.appendVersion({
    id: 'p1', schema: 'tq-secret@1', at: 1,
    payload: { anchor: null, shared: true, label: fakes[0].text, note: fakes[1].text, meta: { k: fakes[2].text } },
  });
  assert.deepEqual(findLeaks(JSON.stringify(rec.payload), fakes), [], 'the stored payload');
  assert.notEqual(rec.payload_hash, rec.src_hash, 'src_hash is the raw payload\'s');
  assert.deepEqual(findLeaks(fs.readFileSync(projectPaths(dir).elementsLog, 'utf8'), fakes), [], 'the file');
});

// ── reopen, the scanner, the chain ──────────────────────────────────────────

test('a reopened log reads a p-id version back with its schema; the scanner reads p ids and a torn tail raises the floor', (t) => {
  registerSchema('tq-back@1', { type: 'tq-back', keys: INK_KEYS });
  const dir = tmpDir(t);
  const file = projectPaths(dir).elementsLog;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const first = createElementLog({ file, redactor: createRedactor() });
  first.load();
  const id = first.mintId('tq-back');
  first.ensureElement({ id, kind: 'tq-back', created_at: 5 });
  const wrote = first.appendVersion({ id, schema: 'tq-back@1', payload: inkPayload(), at: 6 });
  first.close();
  const again = openIn(t, dir);
  const back = again.version(id, 1);
  assert.equal(back.schema, 'tq-back@1');
  assert.equal(back.payload_hash, wrote.payload_hash);
  assert.deepEqual(again.maskView(back).payload, inkPayload());
  assert.equal(again.element(id).kind, 'tq-back');
  again.close();

  assert.equal(maxElementSeqIn('{"t":"el","id":"p40","kind":"tq-back"'), 40);
  assert.equal(maxElementSeqIn('"id": "p7" "id":"c3"'), 7);
  assert.equal(maxElementSeqIn('"id":"pq40" "id":"p" "id":"P40"'), 0, 'p + digits only');
  fs.appendFileSync(file, '{"t":"el","id":"p40","kind":"tq-back","created_at":');
  const torn = openIn(t, dir);
  assert.ok(torn.stats().torn_seq >= 40);
  assert.equal(torn.mintId('tq-back'), 'p41');
});

test('a chain may name a plug-in element: comment@2 and chat-comment@1 accept a p id; an untyped id is still refused', (t) => {
  const log = openIn(t, tmpDir(t));
  const r = log.appendVersion({ id: 'c1', schema: CHAIN_SCHEMA, payload: payloadOf({ text: 'on the ink', anchor: null, chain: ['h2', 'p3'] }), at: 1 });
  assert.deepEqual(r.payload.chain, ['h2', 'p3']);
  fails(() => log.appendVersion({ id: 'c4', schema: CHAIN_SCHEMA, payload: payloadOf({ text: 'x', anchor: null, chain: ['x5'] }), at: 1 }), /typed element ids only/);
  const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');
  const k = log.appendVersion({ id: 'k5', schema: CHAT, payload: { text: 'hi', shared: true, replies: [], anchor: TURN_ANCHOR, chain: ['p3'] }, at: 1 });
  assert.deepEqual(k.payload.chain, ['p3']);
  fails(() => log.appendVersion({ id: 'k6', schema: CHAT, payload: { text: 'hi', shared: true, replies: [], anchor: TURN_ANCHOR, chain: ['q3'] }, at: 1 }), /typed element ids only/);
  for (const id of ['c1', 'h2', 'g3', 'k4', 'p5']) assert.ok(isTypedId(id), id);
  for (const id of ['q1', 'p', 'pp1', 'P1', 'p1a', '', null, 7]) assert.ok(!isTypedId(id), String(id));
});

test('payloadDeclProblem over good and bad declarations', () => {
  const good = [
    { keys: ['anchor', 'shared'] },
    { keys: INK_KEYS },
    { keys: INK_KEYS, max_bytes: 1 },
    { keys: INK_KEYS, max_bytes: PLUGIN_PAYLOAD_MAX },
    { keys: ['anchor', 'shared', ...Array.from({ length: PLUGIN_KEYS_MAX - 2 }, (_, i) => `k${i}`)] },
    { keys: ['anchor', 'shared', 'a_b2', `x${'y'.repeat(30)}`] },
  ];
  for (const d of good) assert.equal(payloadDeclProblem(d, 'tq-decl'), null, JSON.stringify(d));
  const bad = [
    [undefined, /an object/], [null, /an object/], [[], /an object/], ['keys', /an object/],
    [{}, /keys is a list of 1 to 24/], [{ keys: [] }, /keys is a list of 1 to 24/],
    [{ keys: ['anchor', 'shared', ...Array.from({ length: PLUGIN_KEYS_MAX - 1 }, (_, i) => `k${i}`)] }, /keys is a list of 1 to 24/],
    [{ keys: 'anchor' }, /keys is a list/],
    [{ keys: ['anchor', 'shared', 'Bad'] }, /matching/], [{ keys: ['anchor', 'shared', '1x'] }, /matching/],
    [{ keys: ['anchor', 'shared', 'a-b'] }, /matching/], [{ keys: ['anchor', 'shared', `x${'y'.repeat(32)}`] }, /matching/],
    [{ keys: ['anchor', 'shared', 7] }, /matching/],
    [{ keys: ['anchor', 'shared', 'a', 'a'] }, /each name once/],
    [{ keys: ['anchor', 'shared', 'meta'] }, /never names meta/],
    [{ keys: ['shared'] }, /missing anchor/], [{ keys: ['anchor'] }, /missing shared/],
    [{ keys: ['anchor', 'shared'], max_bytes: 0 }, /max_bytes is an integer from 1 to 65536/],
    [{ keys: ['anchor', 'shared'], max_bytes: PLUGIN_PAYLOAD_MAX + 1 }, /max_bytes/],
    [{ keys: ['anchor', 'shared'], max_bytes: 1.5 }, /max_bytes/],
    [{ keys: ['anchor', 'shared'], max_bytes: '100' }, /max_bytes/],
    [{ keys: ['anchor', 'shared'], extra: 1 }, /holds "extra"/],
  ];
  for (const [d, re] of bad) {
    const why = payloadDeclProblem(d, 'tq-decl');
    assert.ok(typeof why === 'string' && re.test(why), `${JSON.stringify(d)} → ${why}`);
  }
  assert.match(payloadDeclProblem({ keys: ['anchor', 'shared'] }, 'highlight'), /built-in type/);
});

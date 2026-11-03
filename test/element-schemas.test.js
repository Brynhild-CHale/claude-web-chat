// The element log's schema table (U326; PLAN.md 2C.4, PLAN-T2 §2.3 2C finding
// (4); rulings E-STORE a, F-GRAB a, U326@id-prefix a): lib/core/element-log.js.
//
// The one writer of element text admits exactly the keys of its version's
// schema (comment@1, highlight@1, box-grab@1, and comment@2 — a chained
// comment, F.6 U406) and hashes exactly those; a
// legacy comment hashes byte for byte as it did at 39b52f8; an engine anchor
// record is stored as given in a comment; ids are minted per type over the one
// seq counter, and the tolerant scanner reads every letter; nodeDigest covers
// comment copies only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const el = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { stableHash } = require('../lib/core/stable-json');
const { projectPaths } = require('../lib/core/paths');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');

const { createElementLog, payloadOf, convertAnchor, copyMatches, nodeDigest, maxElementSeqIn, SCHEMAS, SCHEMA, PAYLOAD_KEYS, ID_PREFIX, CHAIN_SCHEMA, CHAIN_MAX, commentSchemaOf } = el;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-element-schemas-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function openIn(t, dir, opts = {}) {
  const file = projectPaths(dir).elementsLog;
  const log = createElementLog({ file, redactor: opts.redactor || createRedactor() });
  t.after(() => log.close());
  log.load();
  return log;
}

// The schema names, read from the table (the ratchet keeps their literals there).
const [COMMENT, HIGHLIGHT, BOX_GRAB, CHAINED, CHAT] = Object.keys(SCHEMAS);

const ENGINE_ELEMENT = {
  v: 1, kind: 'element', mount: 'm1',
  at: { path: [0, 2, 1], sib: 1 },
  fp: { tag: 'li', id: null, cls: ['row'], head: 'Second item', attrs: ['data-k'], parent: 'ul.list' },
  rows: [{ depth: 2, shape: 'li', sigs: { k: 'b' }, key: 'b', head: 'Second item' }],
};
const ENGINE_RANGE = { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'quick brown', prefix: 'The ', suffix: ' fox' }, ordinal: 0 };
const ENGINE_SOURCE = { v: 1, kind: 'source', md: 'md-intro', slug: 'intro', quote: { exact: 'a line', prefix: '', suffix: '' }, ordinal: 0 };

const highlightPayload = (over = {}) => ({ anchor: ENGINE_RANGE, shared: true, color: 'gold', note: 'look here', ...over });
const boxGrabPayload = (over = {}) => ({
  anchor: ENGINE_ELEMENT,
  shared: true,
  rect: { x: 10, y: 20, w: 300, h: 140, item: 'm1', viewport: { w: 1280, h: 800 } },
  meta: 'ul.list > li.row: Second item',
  grab: { capture: 'cap7' },
  ...over,
});

// ── the table ───────────────────────────────────────────────────────────────

test('SCHEMAS: four frozen rows; SCHEMA and PAYLOAD_KEYS are comment@1\'s name and keys; comment@2 is comment@1\'s keys + chain', () => {
  assert.deepEqual(Object.keys(SCHEMAS), [COMMENT, HIGHLIGHT, BOX_GRAB, CHAINED, CHAT]);
  // tranche 3, U415: chat-comment@1 appended (comment@2's keys, stored as given).
  assert.deepEqual(Object.keys(SCHEMAS), ['comment@1', 'highlight@1', 'box-grab@1', 'comment@2', 'chat-comment@1']);
  assert.ok(Object.isFrozen(SCHEMAS));
  for (const row of Object.values(SCHEMAS)) { assert.ok(Object.isFrozen(row)); assert.ok(Object.isFrozen(row.keys)); }
  assert.equal(SCHEMA, COMMENT);
  assert.deepEqual([...PAYLOAD_KEYS], ['text', 'shared', 'replies', 'anchor']);
  assert.deepEqual(SCHEMAS[COMMENT].keys, ['text', 'shared', 'replies', 'anchor']);
  assert.equal(SCHEMAS[COMMENT].normalise, payloadOf);
  assert.deepEqual(SCHEMAS[HIGHLIGHT].keys, ['anchor', 'shared', 'color', 'note']);
  assert.deepEqual(SCHEMAS[BOX_GRAB].keys, ['anchor', 'shared', 'rect', 'meta', 'grab']);
  assert.deepEqual(SCHEMAS[CHAINED].keys, [...SCHEMAS[COMMENT].keys, 'chain'], 'comment@1\'s keys, then chain');
  assert.equal(SCHEMAS[CHAINED].normalise, payloadOf);
  assert.ok(!SCHEMAS[COMMENT].keys.includes('chain'), 'never a chain key on comment@1 (the rows are additive)');
  assert.deepEqual(Object.fromEntries(Object.entries(SCHEMAS).map(([k, r]) => [k, r.type])),
    { [COMMENT]: 'comment', [HIGHLIGHT]: 'highlight', [BOX_GRAB]: 'box-grab', [CHAINED]: 'comment', [CHAT]: 'chat-comment' });
  assert.deepEqual(ID_PREFIX, { comment: 'c', highlight: 'h', 'box-grab': 'g', 'chat-comment': 'k' });
  assert.ok(Object.isFrozen(ID_PREFIX));
});

// ── each schema round-trips ─────────────────────────────────────────────────

test('appendVersion: each schema round-trips through version(), maskView() and a reopen, hashing exactly its keys', (t) => {
  const dir = tmpDir(t);
  const cases = [
    { id: 'c1', schema: COMMENT, payload: payloadOf({ text: 'hello', shared: true, anchor: ENGINE_ELEMENT }) },
    { id: 'h2', schema: HIGHLIGHT, payload: highlightPayload() },
    { id: 'g3', schema: BOX_GRAB, payload: boxGrabPayload() },
    { id: 'g4', schema: BOX_GRAB, payload: boxGrabPayload({ grab: null }) },
  ];
  const log = openIn(t, dir);
  const stored = new Map();
  for (const c of cases) {
    const rec = log.appendVersion({ id: c.id, schema: c.schema, payload: c.payload, at: 1 });
    assert.equal(rec.schema, c.schema);
    assert.deepEqual(rec.payload, c.payload, `${c.schema}: stored as given`);
    assert.deepEqual(Object.keys(rec.payload).sort(), Object.keys(c.payload).sort());
    assert.ok(Object.keys(rec.payload).every((k) => SCHEMAS[c.schema].keys.includes(k)));
    assert.equal(rec.payload_hash, stableHash(c.payload), `${c.schema}: payload_hash covers the payload's keys only`);
    assert.equal(rec.src_hash, stableHash(c.payload), `${c.schema}: src_hash covers the payload's keys only`);
    assert.deepEqual(log.version(c.id, 1).payload, c.payload);
    assert.deepEqual(log.maskView(log.version(c.id, 1)).payload, c.payload);
    stored.set(c.id, rec);
  }
  // A sibling field changes neither hash.
  const sib = log.appendVersion({ id: 'h2', schema: HIGHLIGHT, payload: highlightPayload(), parent_v: 1, writer: { class: 'user' }, provenance: { via: 'x' }, owner: 'claude', at: 2 });
  assert.equal(sib.payload_hash, stored.get('h2').payload_hash);
  log.close();

  const again = openIn(t, dir);
  for (const c of cases) {
    const v = again.version(c.id, 1);
    assert.equal(v.schema, c.schema);
    assert.deepEqual(v.payload, c.payload, `${c.schema}: the reopen reads the same payload`);
    assert.equal(v.payload_hash, stored.get(c.id).payload_hash);
    assert.equal(v.src_hash, stored.get(c.id).src_hash);
    assert.equal(stableHash(v.payload), v.payload_hash, 'a stored record rehashes to its own hash');
    assert.deepEqual(again.byHash(c.id, v.payload_hash), [1].concat(c.id === 'h2' ? [2] : []));
  }
});

test('appendVersion: a non-comment payload is jsonClean\'d (undefined dropped) with its anchor kept as given', (t) => {
  const log = openIn(t, tmpDir(t));
  const rec = log.appendVersion({ id: 'h1', schema: HIGHLIGHT, payload: { anchor: ENGINE_SOURCE, shared: undefined, color: 'accent', note: undefined }, at: 1 });
  assert.deepEqual(rec.payload, { anchor: ENGINE_SOURCE, color: 'accent' });
  assert.equal(rec.payload_hash, stableHash({ anchor: ENGINE_SOURCE, color: 'accent' }));
  // A legacy-looking anchor on a highlight is NOT converted: only comment@1 normalises.
  const legacy = { mount: 'm', selector: 'p', text: 'T', ordinal: 0 };
  const r2 = log.appendVersion({ id: 'h2', schema: HIGHLIGHT, payload: { anchor: legacy, shared: true }, at: 2 });
  assert.deepEqual(r2.payload.anchor, legacy);
});

// ── refusals ────────────────────────────────────────────────────────────────

test('appendVersion: an unknown schema and a stray key per schema are refused, naming the schema; nothing lands', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  for (const schema of ['comment@3', 'note@1', '', null, 7, 'toString', '__proto__']) {
    assert.throws(() => log.appendVersion({ id: 'x1', schema, payload: { anchor: null }, at: 1 }),
      (e) => e instanceof TypeError && /unknown schema/.test(e.message) && e.message.includes(JSON.stringify(schema)), `schema ${String(schema)}`);
  }
  const strays = {
    [COMMENT]: { ...payloadOf({ text: 'x', anchor: null }), color: 'gold' },
    [HIGHLIGHT]: { ...highlightPayload(), text: 'x' },
    [BOX_GRAB]: { ...boxGrabPayload(), image: 'iVBORw0KGgo=' },
  };
  for (const [schema, payload] of Object.entries(strays)) {
    assert.throws(() => log.appendVersion({ id: 'x2', schema, payload, at: 1 }),
      (e) => e instanceof TypeError && e.message.includes(schema) && /not (color|text|image)/.test(e.message), schema);
  }
  // The comment's default schema still refuses a stray key, naming comment@1.
  assert.throws(() => log.appendVersion({ id: 'x3', payload: { text: 'x', note: 'n' } }), (e) => e.message.includes(COMMENT) && /not note/.test(e.message));
  // A box grab's grab is a capture reference, never the image.
  for (const grab of [{ capture: 'cap7', png: 'AAAA' }, { png: 'AAAA' }, 'cap7', { capture: 'q3' }, { capture: 7 }, ['cap7']]) {
    assert.throws(() => log.appendVersion({ id: 'x4', schema: BOX_GRAB, payload: boxGrabPayload({ grab }), at: 1 }),
      (e) => e instanceof TypeError && e.message.includes(BOX_GRAB) && /capture reference/.test(e.message), JSON.stringify(grab));
  }
  assert.equal(log.stats().versions, 0, 'no refused write landed');
  assert.equal(fs.existsSync(projectPaths(dir).elementsLog) ? fs.readFileSync(projectPaths(dir).elementsLog, 'utf8').includes('"t":"ver"') : false, false);
});

// ── the redactor ────────────────────────────────────────────────────────────

test('appendVersion: a highlight\'s note and a box grab\'s meta pass the injected redactor (masked on disk and on read)', (t) => {
  const dir = tmpDir(t);
  const fakes = fakeSecrets({ seed: 0x3260 }).filter((f) => !f.context && !f.known).slice(0, 4);
  const log = openIn(t, dir);
  fakes.forEach((f, i) => {
    log.appendVersion({ id: `h${2 * i + 1}`, schema: HIGHLIGHT, payload: highlightPayload({ note: `see ${f.text}` }), at: 1 });
    log.appendVersion({ id: `g${2 * i + 2}`, schema: BOX_GRAB, payload: boxGrabPayload({ meta: `div: ${f.text}` }), at: 1 });
  });
  const bytes = fs.readFileSync(projectPaths(dir).elementsLog, 'utf8');
  assert.deepEqual(findLeaks(bytes, fakes), [], 'nothing a rule masks reaches the file');
  for (let i = 0; i < fakes.length; i++) {
    const h = log.version(`h${2 * i + 1}`, 1);
    const g = log.version(`g${2 * i + 2}`, 1);
    assert.deepEqual(findLeaks(JSON.stringify([h.payload, g.payload]), fakes), [], 'nothing on read');
    assert.notEqual(h.payload_hash, h.src_hash, 'the raw payload hashes apart from the stored one');
  }

  // A value the redactor learns after the write is masked on every read; the bytes stay.
  const r = createRedactor();
  const later = openIn(t, tmpDir(t), { redactor: r });
  const value = 'learned-later-value-3260';
  later.appendVersion({ id: 'g1', schema: BOX_GRAB, payload: boxGrabPayload({ meta: `a ${value}` }), at: 1 });
  later.appendVersion({ id: 'h2', schema: HIGHLIGHT, payload: highlightPayload({ note: `b ${value}` }), at: 1 });
  assert.ok(r.addKnown(value, 'known'));
  assert.ok(!later.version('g1', 1).payload.meta.includes(value));
  assert.ok(!later.version('h2', 1).payload.note.includes(value));
});

// ── comment@1: byte-equal to 39b52f8 ────────────────────────────────────────

const PIN_LOCATOR = {
  v: 1, kind: 'element', form: 'pin-locator@1', mount: 'm', path: { selector: 'div.a.b' }, fingerprint: { tag: 'div', classes: ['a', 'b'], text: 'T' }, ordinal: 2,
};
// Each fixture's payload_hash and src_hash, recorded from the code at 39b52f8
// (appendVersion over payloadOf, createRedactor()).
const LEGACY = {
  withReplies: {
    copy: { text: 'hello', shared: true, replies: [{ author: 'user', at: 5, text: 'hi', writer: { class: 'user' } }, { author: 'claude', at: 6, text: 'ok' }], anchor: { mount: 'm1', selector: 'div.card.big', text: 'Card', ordinal: 2 } },
    hash: '1ba1de0bb5330cf4f1b3d5370b2afe5e405f2f50',
  },
  noRepliesSharedUndefined: {
    copy: { text: 'no replies', anchor: { mount: 'm2', selector: 'p', text: 'x', ordinal: null } },
    hash: '08ec1d2f5b2b3a18c4e6d908873c49ac1b4b3b77',
  },
  pinLocator: {
    copy: { text: 'conv', shared: false, replies: [], anchor: PIN_LOCATOR },
    hash: 'a5b3d06c4f34d5544747b777282b6b4f58c95f2c',
  },
  nullAnchor: {
    copy: { text: 'nothing anchored', shared: true, anchor: null },
    hash: 'f42709f118574214ddbc30e0d3818bfed3af9d56',
  },
};
// A secret in the text and a reply: src_hash (the raw payload) recorded at 39b52f8.
const SECRET_SRC_HASH = 'b6578e990449998c870d3cce3164f4ff73dbd818';

test('comment@1: every legacy copy hashes byte-equal to 39b52f8 (payload_hash and src_hash)', (t) => {
  const log = openIn(t, tmpDir(t));
  let i = 0;
  for (const [name, { copy, hash }] of Object.entries(LEGACY)) {
    const rec = log.appendVersion({ id: `c${++i}`, payload: payloadOf(copy), at: 1 });
    assert.equal(rec.schema, COMMENT);
    assert.equal(rec.payload_hash, hash, `${name}: payload_hash`);
    assert.equal(rec.src_hash, hash, `${name}: src_hash`);
    assert.ok(copyMatches(copy, rec), `${name}: the copy still finds its version`);
  }
  const ghp = fakeSecrets({ seed: 0x326 }).find((f) => f.id === 'github-ghp');
  const copy = { text: `note: ${ghp.text}`, shared: true, replies: [{ author: 'user', at: 7, text: ghp.text }], anchor: { mount: 'm3', selector: 'span', text: 'S', ordinal: 0 } };
  const rec = log.appendVersion({ id: 'c9', payload: payloadOf(copy), at: 1 });
  assert.equal(rec.src_hash, SECRET_SRC_HASH, 'the raw copy\'s hash');
  assert.equal(rec.payload_hash, stableHash(rec.payload), 'the stored copy\'s hash');
  assert.notEqual(rec.payload_hash, rec.src_hash);
  assert.ok(copyMatches(copy, rec));
});

test('comment@1: an engine element, range and source record is kept as given; a legacy locator is still converted', () => {
  for (const anchor of [ENGINE_ELEMENT, ENGINE_RANGE, ENGINE_SOURCE]) {
    const p = payloadOf({ text: 't', anchor });
    assert.equal(p.anchor, anchor, `${anchor.kind}: the same record, untouched`);
    assert.ok(el.isEngineRecord(anchor));
    assert.equal(stableHash(p), stableHash({ text: 't', replies: [], anchor }));
  }
  const legacy = { mount: 'm', selector: 'div.a.b', text: 'T', ordinal: 2 };
  assert.deepEqual(payloadOf({ text: 't', anchor: legacy }).anchor, convertAnchor(legacy));
  assert.deepEqual(payloadOf({ text: 't', anchor: legacy }).anchor, PIN_LOCATOR);
  // The recognition is narrow: a form key, a top-level selector, another v or kind → converted.
  const near = [
    { ...ENGINE_ELEMENT, form: 'x' },
    { ...ENGINE_ELEMENT, selector: 'li.row' },
    { ...ENGINE_ELEMENT, v: 2 },
    { ...ENGINE_ELEMENT, kind: 'pane' },
  ];
  for (const a of near) {
    assert.equal(el.isEngineRecord(a), false);
    assert.deepEqual(payloadOf({ text: 't', anchor: a }).anchor, convertAnchor(a));
  }
  // isConverted's idempotence: a converted record passes through convertAnchor and payloadOf unchanged.
  assert.equal(convertAnchor(PIN_LOCATOR), PIN_LOCATOR);
  assert.equal(payloadOf({ text: 't', anchor: PIN_LOCATOR }).anchor, PIN_LOCATOR);
  assert.deepEqual(payloadOf(payloadOf({ text: 't', anchor: legacy })), payloadOf({ text: 't', anchor: legacy }));
  assert.equal(el.isEngineRecord(PIN_LOCATOR), false, 'a converted locator carries a form');
});

test('comment@1: a version storing an engine anchor round-trips and its copy matches', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const copy = { id: 'c1', text: 'on the row', shared: true, replies: [], anchor: ENGINE_ELEMENT };
  const rec = log.appendVersion({ id: 'c1', payload: payloadOf(copy), at: 1 });
  assert.deepEqual(rec.payload.anchor, ENGINE_ELEMENT);
  assert.ok(copyMatches(copy, rec));
  log.close();
  const again = openIn(t, dir);
  assert.deepEqual(again.version('c1', 1).payload.anchor, ENGINE_ELEMENT);
  assert.ok(copyMatches(copy, again.version('c1', 1)));
});

// ── comment@2: the chain (F.6, U406) ────────────────────────────────────────

test('CHAIN_SCHEMA is read from the table (the comment row whose keys hold chain); commentSchemaOf picks it only for a payload carrying a chain', () => {
  const fromTable = Object.keys(SCHEMAS).filter((k) => SCHEMAS[k].type === 'comment' && SCHEMAS[k].keys.includes('chain'));
  assert.deepEqual(fromTable, [CHAIN_SCHEMA]);
  assert.equal(CHAIN_SCHEMA, CHAINED);
  assert.equal(CHAIN_MAX, 8);
  assert.equal(commentSchemaOf(payloadOf({ text: 'x', anchor: null })), SCHEMA);
  assert.equal(commentSchemaOf(payloadOf({ text: 'x', anchor: null, chain: [] })), SCHEMA, 'an empty chain is no chain');
  assert.equal(commentSchemaOf(payloadOf({ text: 'x', anchor: null, chain: ['h7'] })), CHAIN_SCHEMA);
  assert.equal(commentSchemaOf(null), SCHEMA);
});

test('payloadOf: a chain is kept (a copy) only when it is a non-empty list of strings; a chainless payload hashes byte-equal to comment@1\'s (the 39b52f8 copies)', (t) => {
  const chain = ['h7', 'g3'];
  const p = payloadOf({ text: 't', anchor: null, chain });
  assert.deepEqual(p.chain, chain);
  assert.notEqual(p.chain, chain, 'a copy');
  for (const bad of [[], null, undefined, 'h7', [7], ['h7', null]]) {
    assert.equal('chain' in payloadOf({ text: 't', anchor: null, chain: bad }), false, JSON.stringify(bad));
  }
  // Every legacy copy, with an empty or absent chain, hashes as recorded at 39b52f8.
  const log = openIn(t, tmpDir(t));
  let i = 0;
  for (const [name, { copy, hash }] of Object.entries(LEGACY)) {
    for (const c of [copy, { ...copy, chain: [] }]) {
      const payload = payloadOf(c);
      assert.equal(stableHash(payload), hash, `${name}: the hash`);
      assert.equal(commentSchemaOf(payload), COMMENT);
      const rec = log.appendVersion({ id: `c${++i}`, schema: commentSchemaOf(payload), payload, at: 1 });
      assert.equal(rec.schema, COMMENT);
      assert.equal(rec.payload_hash, hash, `${name}: payload_hash`);
      assert.ok(copyMatches(copy, rec), `${name}: the 0.8.5 copy still finds its version`);
    }
  }
});

test('comment@2: a chained payload round-trips and its copy matches; the chain is checked (at most CHAIN_MAX typed ids, each once); a chainless comment@2 and a chain under comment@1 are refused', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const copy = { id: 'c1', text: 'on the highlight', shared: true, replies: [], anchor: ENGINE_RANGE, chain: ['h7', 'g3'] };
  const payload = payloadOf(copy);
  const rec = log.appendVersion({ id: 'c1', schema: commentSchemaOf(payload), payload, at: 1 });
  assert.equal(rec.schema, CHAINED);
  assert.deepEqual(rec.payload.chain, ['h7', 'g3']);
  assert.equal(rec.payload_hash, stableHash(payload), 'the chain is hashed');
  assert.ok(copyMatches(copy, rec));
  assert.ok(!copyMatches({ ...copy, chain: undefined }, rec), 'a copy without the chain is another payload');
  log.close();
  const again = openIn(t, dir);
  assert.deepEqual(again.version('c1', 1).payload.chain, ['h7', 'g3']);
  assert.equal(again.version('c1', 1).schema, CHAINED);
  // The refusals, naming comment@2; nothing lands.
  const ids = (n) => Array.from({ length: n }, (_, k) => `h${k + 1}`);
  assert.doesNotThrow(() => again.appendVersion({ id: 'c2', schema: CHAINED, payload: payloadOf({ text: 'max', anchor: null, chain: ids(CHAIN_MAX) }), at: 1 }));
  const before = again.stats().versions;
  for (const [why, chain, re] of [
    ['CHAIN_MAX + 1', ids(CHAIN_MAX + 1), /at most 8/],
    ['a duplicate', ['h7', 'g3', 'h7'], /each id once/],
    ['a non-typed id', ['h7', 'x9'], /typed element ids/],
    ['a hand-written id', ['note-1'], /typed element ids/],
    ['a letter with no digits', ['h'], /typed element ids/],
  ]) {
    assert.throws(() => again.appendVersion({ id: 'c3', schema: CHAINED, payload: { ...payloadOf({ text: 'x', anchor: null }), chain }, at: 1 }),
      (e) => e instanceof TypeError && e.message.includes(CHAINED) && re.test(e.message), why);
  }
  assert.throws(() => again.appendVersion({ id: 'c3', schema: CHAINED, payload: payloadOf({ text: 'x', anchor: null }), at: 1 }),
    (e) => e instanceof TypeError && e.message.includes(CHAINED) && /non-empty list/.test(e.message), 'a chainless comment@2');
  // A stray chain under comment@1 (the default schema) is refused naming comment@1.
  for (const opts of [{}, { schema: COMMENT }]) {
    assert.throws(() => again.appendVersion({ id: 'c3', ...opts, payload: payloadOf({ text: 'x', anchor: null, chain: ['h7'] }), at: 1 }),
      (e) => e instanceof TypeError && e.message.includes(`a ${COMMENT} payload`) && /not chain/.test(e.message));
  }
  assert.equal(again.stats().versions, before, 'no refused write landed');
  // The chain rides a comment only: a highlight's payload never holds one.
  assert.throws(() => again.appendVersion({ id: 'h9', schema: HIGHLIGHT, payload: { ...highlightPayload(), chain: ['g3'] }, at: 1 }),
    (e) => e.message.includes(HIGHLIGHT) && /not chain/.test(e.message));
});

// ── typed mints ─────────────────────────────────────────────────────────────

test('mintId(type): a letter per type over the one seq counter (c1, h2, g3, c4); mintId() is a comment', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const a = log.mintId();
  const b = log.mintId('highlight');
  const c = log.mintId('box-grab');
  const d = log.mintId('comment');
  assert.deepEqual([a, b, c, d], ['c1', 'h2', 'g3', 'c4']);
  assert.throws(() => log.mintId('note'), (e) => e instanceof TypeError && /not note/.test(e.message));
  assert.throws(() => log.mintId('toString'), TypeError);
  // Each id's first version takes the seq its id carries.
  assert.equal(log.appendVersion({ id: b, schema: HIGHLIGHT, payload: highlightPayload(), at: 1 }).seq, 2);
  assert.equal(log.appendVersion({ id: c, schema: BOX_GRAB, payload: boxGrabPayload(), at: 1 }).seq, 3);
  assert.equal(log.appendVersion({ id: a, payload: payloadOf({ text: 'x', anchor: null }), at: 1 }).seq, 1);
  log.close();
  // Never decreases across a reopen: the next mint, whatever its type, is past
  // every seq the log spent (c4 was only reserved, in memory, and never written).
  const again = openIn(t, dir);
  assert.equal(again.mintId('highlight'), 'h4');
});

test('maxElementSeqIn: the torn-bytes scanner reads h and g ids as it reads c ids', (t) => {
  assert.equal(maxElementSeqIn('{"t":"ver","id":"h17","v":1'), 17);
  assert.equal(maxElementSeqIn('{"t":"el","id": "g18","kind":"box-grab"'), 18);
  assert.equal(maxElementSeqIn('"id":"c3" "id":"h17" "id":"g18" "seq":4'), 18);
  assert.equal(maxElementSeqIn('"id":"x99" "id":"n42" "id":"cap77"'), 0, 'only the table\'s letters (a node id or a capture id is not an element)');
  // The scanner's letters are exactly ID_PREFIX's plus the plug-in letter (its regex is a literal: this holds the two equal; U513).
  for (const l of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    assert.equal(maxElementSeqIn(`"id":"${l}21"`), [...Object.values(ID_PREFIX), el.PLUGIN_ID_LETTER].includes(l) ? 21 : 0, l);
  }

  // A torn tail holding an h or g id raises the mint floor.
  const dir = tmpDir(t);
  const file = projectPaths(dir).elementsLog;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const first = createElementLog({ file, redactor: createRedactor() });
  first.load();
  first.appendVersion({ id: 'c1', payload: payloadOf({ text: 'x', anchor: null }), at: 1 });
  first.close();
  fs.appendFileSync(file, '{"t":"el","id":"g40","kind":"box-grab","created_at":');
  const log = openIn(t, dir);
  assert.ok(log.stats().torn_seq >= 40);
  assert.equal(log.mintId('highlight'), 'h41');
});

// ── the digest ──────────────────────────────────────────────────────────────

test('nodeDigest covers comment copies only: an elements field leaves it unchanged', () => {
  const node = { id: 'n7', parent_id: 'n6', created_at: 1000, comments: [{ id: 'c1', v: 2 }, { id: 'c3', v: 1 }] };
  const withRefs = { ...node, elements: ['h4@1', 'g5@2', 'c1@2'] };
  assert.equal(nodeDigest(withRefs), nodeDigest(node));
  assert.equal(nodeDigest({ ...withRefs, elements: [] }), nodeDigest(node));
  assert.notEqual(nodeDigest({ ...node, comments: [{ id: 'c1', v: 3 }, { id: 'c3', v: 1 }] }), nodeDigest(node));
});

// ── the schema matches the id (K.2-28; U325) ────────────────────────────────

test('appendVersion refuses a version whose schema is not its id\'s type (the id\'s letter) or its el record\'s kind, with its own reason; nothing is written', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const c = log.mintId('comment');
  log.ensureElement({ id: c, kind: 'comment', created_at: 1 });
  log.appendVersion({ id: c, payload: payloadOf({ text: 'a pin', anchor: null }), at: 1 });
  const bytes = () => fs.readFileSync(projectPaths(dir).elementsLog, 'utf8');
  const before = bytes();
  const refused = (e) => e instanceof TypeError && e.reason === 'schema-type-mismatch';
  // A highlight@1 version on a comment's id.
  assert.throws(() => log.appendVersion({ id: c, schema: HIGHLIGHT, payload: highlightPayload(), parent_v: 1, at: 2 }), refused);
  // A comment@1 version on a box grab's id, by its letter alone (no el record).
  assert.throws(() => log.appendVersion({ id: 'g9', payload: payloadOf({ text: 'x', anchor: null }), at: 2 }), refused);
  // An el record's kind decides for an id the letter table does not name.
  log.ensureElement({ id: 'note-1', kind: 'highlight', created_at: 1 });
  assert.throws(() => log.appendVersion({ id: 'note-1', schema: BOX_GRAB, payload: boxGrabPayload(), at: 2 }), refused);
  assert.equal(log.appendVersion({ id: 'note-1', schema: HIGHLIGHT, payload: highlightPayload(), at: 2 }).v, 1);
  assert.equal(log.version(c, 2), null, 'nothing appended on the comment');
  assert.ok(bytes().startsWith(before));
  assert.equal(el.typeOfId('h12'), 'highlight');
  assert.equal(el.typeOfId('c3'), 'comment');
  assert.equal(el.typeOfId('x3'), null);
  assert.equal(el.typeOfId('h1x'), null);
});

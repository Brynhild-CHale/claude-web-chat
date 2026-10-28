// The annotation engine's per-type remote policy (lib/core/element-policy.js,
// PLAN.md 1B.1, decision A4): the built-in types, the descriptor's floor (read
// to see, full to send — a type may tighten it, never loosen it), and the pure
// compile into the portal's type-agnostic floor rows, the daemon's per-type
// gates, one frame row a type and the private frame paths. remote-policy's own
// tests hold what it does with them (test/remote-policy.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  BUILTIN_ELEMENT_TYPES, ELEMENT_FAMILIES, GATE_LEVELS, FLOOR,
  validateDescriptor, compileElementPolicy, frameType,
} = require('../lib/core/element-policy');
const { MIRROR_LEVELS, RULES, FRAME_RULES, PRIVATE_RULES, ELEMENT_POLICY, keyOf } = require('../lib/core/remote-policy');

const SOURCE = path.join(__dirname, '..', 'lib', 'core', 'element-policy.js');
const desc = (over = {}) => ({ type: 'sticky-note', family: 'page', remote: { see: 'read', send: 'full' }, private: false, ...over });

test('the module has no require(): the portal loads it beside remote-policy, and it is lib/core\'s leaf', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  assert.equal(/\brequire\s*\(/.test(src), false, 'element-policy.js requires nothing');
  assert.equal(/\bimport\s*\(/.test(src), false);
});

test('the built-in types: comment, highlight, box-grab — page family, at the floor, private allowed; frozen', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(BUILTIN_ELEMENT_TYPES)), [
    ...['comment', 'highlight', 'box-grab'].map((type) => ({ type, family: 'page', remote: { see: 'read', send: 'full' }, private: true })),
    // tranche 3, U415 (RULED CHAT@type a): the chat comment, family chat.
    { type: 'chat-comment', family: 'chat', remote: { see: 'read', send: 'full' }, private: true },
  ]);
  const frozenDeep = (o) => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(frozenDeep));
  assert.ok(frozenDeep(BUILTIN_ELEMENT_TYPES));
  assert.deepStrictEqual(FLOOR, { see: 'read', send: 'full' });
  assert.deepStrictEqual([...ELEMENT_FAMILIES], ['page', 'graph', 'chat']);
  assert.deepStrictEqual([...GATE_LEVELS], MIRROR_LEVELS.slice(MIRROR_LEVELS.indexOf('read')), 'the gate levels are the mirror levels from read up');
});

test('compileElementPolicy is pure and deterministic: two calls deep-equal; input order irrelevant', () => {
  const a = compileElementPolicy(BUILTIN_ELEMENT_TYPES);
  const b = compileElementPolicy(BUILTIN_ELEMENT_TYPES);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(compileElementPolicy([...BUILTIN_ELEMENT_TYPES].reverse()), a);
  assert.deepStrictEqual(compileElementPolicy(BUILTIN_ELEMENT_TYPES.map((d) => JSON.parse(JSON.stringify(d)))), a, 'a plain copy compiles the same');
  assert.deepStrictEqual(ELEMENT_POLICY, a, 'remote-policy compiles the built-ins');
  const frozenDeep = (o) => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(frozenDeep));
  assert.ok(frozenDeep(a));
});

test('floorRules: exactly the four /api/elements rows, in first-match order, whatever the types', () => {
  const { floorRules } = compileElementPolicy(BUILTIN_ELEMENT_TYPES);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(floorRules)), [
    { methods: ['GET'], path: '/api/elements/search', allow: true, mirror: 'read' },
    { methods: ['GET'], path: '/api/elements/*', allow: true, mirror: 'read' },
    { methods: ['POST', 'PATCH', 'DELETE'], path: '/api/elements/*', allow: true, mirror: 'full' },
    { methods: '*', path: '/api/elements/*', allow: false },
  ]);
  assert.deepStrictEqual(compileElementPolicy([]).floorRules, floorRules, 'type-agnostic: a plug-in type never changes the portal\'s rows');
  assert.deepStrictEqual(compileElementPolicy([desc({ remote: { see: 'full', send: 'full' } })]).floorRules, floorRules);
  // In RULES as written, each with its words.
  const inRules = RULES.filter((r) => r.path.startsWith('/api/elements'));
  assert.deepStrictEqual(inRules.map(keyOf), floorRules.map(keyOf));
  for (const r of inRules) assert.ok(typeof r.hint === 'string' && r.hint, keyOf(r));
});

test('typeGates, frames and privatePaths for the built-ins', () => {
  const { typeGates, frames, privatePaths } = compileElementPolicy(BUILTIN_ELEMENT_TYPES);
  assert.deepStrictEqual(typeGates.comment, { see: 'read', send: 'full' });
  assert.deepStrictEqual(Object.keys(typeGates), ['box-grab', 'chat-comment', 'comment', 'highlight'], 'sorted by type');
  assert.deepStrictEqual(typeGates['chat-comment'], { see: 'read', send: 'full' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(frames)), [
    { type: 'element:box-grab', level: 'read' },
    { type: 'element:chat-comment', level: 'read' },
    { type: 'element:comment', level: 'read' },
    { type: 'element:highlight', level: 'read' },
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(privatePaths)), {
    'element:box-grab': ['elements[]'], 'element:chat-comment': ['elements[]'], 'element:comment': ['elements[]'], 'element:highlight': ['elements[]'],
  });
  assert.equal(frameType('comment'), 'element:comment');
  // remote-policy carries each: one FRAME_RULES row and one PRIVATE_RULES entry a type.
  for (const f of frames) {
    assert.deepStrictEqual(FRAME_RULES.find((r) => r.type === f.type), f, f.type);
    assert.deepStrictEqual(PRIVATE_RULES.frames[f.type], ['elements[]'], f.type);
  }
  const shared = compileElementPolicy([desc()]);
  assert.deepStrictEqual(shared.privatePaths, {}, 'a type that holds no private records drops nothing');
});

test('a descriptor may tighten its gate; one that loosens it throws a TypeError naming the type', () => {
  const tight = compileElementPolicy([desc({ remote: { see: 'full', send: 'full' } })]);
  assert.deepStrictEqual(tight.typeGates['sticky-note'], { see: 'full', send: 'full' });
  assert.deepStrictEqual(tight.frames, [{ type: 'element:sticky-note', level: 'full' }]);
  assert.deepStrictEqual(compileElementPolicy([desc({ remote: { see: 'local', send: 'local' } })]).typeGates['sticky-note'],
    { see: 'local', send: 'local' }, 'a type no remote viewer gets');
  for (const remote of [{ see: 'basic', send: 'full' }, { see: 'read', send: 'read' }, { see: 'read', send: 'basic' },
    { see: 'full', send: 'read' }, { see: 'local', send: 'full' }]) {
    assert.throws(() => compileElementPolicy([desc({ remote })]), (e) => e instanceof TypeError && /"sticky-note"/.test(e.message),
      JSON.stringify(remote));
  }
  assert.throws(() => compileElementPolicy([desc({ remote: { see: 'basic', send: 'full' } })]), /loosens the floor/);
  assert.throws(() => compileElementPolicy([desc(), desc()]), /declared twice/);
  assert.throws(() => compileElementPolicy('comment'), TypeError);
});

test('validateDescriptor refuses an unknown family, a non-kebab type, a level that is not one, a non-boolean private', () => {
  assert.deepStrictEqual(validateDescriptor(desc()), desc());
  assert.ok(Object.isFrozen(validateDescriptor(desc())));
  assert.equal(validateDescriptor({ type: 'x', family: 'chat', remote: { see: 'read', send: 'full' } }).private, false, 'private defaults false');
  const bad = [
    [desc({ family: 'nonsense' }), /family/],
    [desc({ family: undefined }), /family/],
    [desc({ type: 'Sticky' }), /kebab/],
    [desc({ type: 'sticky_note' }), /kebab/],
    [desc({ type: 'sticky--note' }), /kebab/],
    [desc({ type: '-sticky' }), /kebab/],
    [desc({ type: 'a'.repeat(41) }), /kebab/],
    [desc({ type: 7 }), /kebab/],
    [desc({ remote: { see: 'public', send: 'full' } }), /remote\.see/],
    [desc({ remote: { see: 'read' } }), /remote\.send/],
    [desc({ remote: null }), /remote/],
    [desc({ private: 'yes' }), /private/],
    [null, /object/],
    [['comment'], /object/],
  ];
  for (const [d, re] of bad) {
    assert.throws(() => validateDescriptor(d), (e) => e instanceof TypeError && re.test(e.message), JSON.stringify(d));
  }
  const input = Object.freeze(desc());
  validateDescriptor(input);
  assert.deepStrictEqual(input, desc(), 'never mutates its input');
});

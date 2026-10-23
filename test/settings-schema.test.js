// lib/core/settings-schema — THE settings-schema subset (annotation engine
// tranche 2, U335; PLAN.md 2D.5): exactly the form-renderer's (an object root
// with string / number / integer / boolean / enum properties and required[]),
// so whatever a type declares can be drawn by that one renderer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ss = require('../lib/core/settings-schema');
const { validateSchema, checkValue } = ss;

const FULL = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name', description: 'What it is called.', maxLength: 20, default: 'pen' },
    width: { type: 'number', minimum: 0.5, maximum: 8, default: 1.5 },
    count: { type: 'integer', minimum: 1, maximum: 9 },
    shared: { type: 'boolean', title: 'Visible to Claude', default: true },
    color: { type: 'string', enum: ['gold', 'accent', 'green', 'rust'], default: 'gold' },
    step: { type: 'integer', enum: [1, 2, 4] },
  },
  required: ['name', 'color'],
  additionalProperties: false,
};

const paths = (r) => r.errors.map((e) => e.path);

test('the form-renderer subset validates: string, number, integer, boolean, enum and required', () => {
  assert.deepStrictEqual(validateSchema(FULL), { ok: true, errors: [] });
  assert.deepStrictEqual(validateSchema({ type: 'object', properties: {} }), { ok: true, errors: [] });
  // The form-renderer's own description names the subset.
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'components', 'form-renderer', 'meta.json'), 'utf8'));
  assert.match(meta.description, /object root with string\/number\/integer\/boolean\/enum properties \+ required\[\]/);
});

test('a nested object, an array, a $ref, 33 properties, a dotted key and a mixed-type enum are each refused with a path', () => {
  const cases = [
    [{ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } }, ['properties.a.properties', 'properties.a.type'], /nested object/],
    [{ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } }, ['properties.a.items', 'properties.a.type'], /array/],
    [{ type: 'object', properties: { a: { $ref: '#/defs/x' } } }, ['properties.a.$ref', 'properties.a.type'], /\$ref/],
    [{ $ref: '#/defs/root', type: 'object', properties: {} }, ['$ref'], /\$ref/],
    [{ type: 'object', properties: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, { type: 'string' }])) }, ['properties'], /at most 32 properties \(got 33\)/],
    [{ type: 'object', properties: { 'a.b': { type: 'string' } } }, ['properties.a.b'], /a property key is a letter/],
    [{ type: 'object', properties: { a: { type: 'string', enum: ['x', 1] } } }, ['properties.a.enum'], /every value must be a string/],
    [{ type: 'object', properties: {}, patternProperties: { '^x': { type: 'string' } } }, ['patternProperties'], /not in the settings subset/],
    [{ type: 'object', properties: {}, additionalProperties: true }, ['additionalProperties'], /may only be false/],
  ];
  for (const [schema, want, re] of cases) {
    const r = validateSchema(schema);
    assert.equal(r.ok, false, JSON.stringify(schema).slice(0, 80));
    assert.deepStrictEqual(paths(r), want, JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => re.test(e.why)), JSON.stringify(r.errors));
  }
});

test('the rest of the grammar: root shape, keys, lengths, bounds, enum size, defaults and required', () => {
  const bad = (schema, want) => {
    const r = validateSchema(schema);
    assert.equal(r.ok, false, JSON.stringify(schema));
    assert.deepStrictEqual(paths(r), want, JSON.stringify(r.errors));
  };
  const one = (spec) => ({ type: 'object', properties: { a: spec } });
  for (const s of [null, [], 'object', 3]) bad(s, ['']);
  bad({ type: 'string', properties: {} }, ['type']);
  bad({ type: 'object' }, ['properties']);
  bad({ type: 'object', properties: {}, title: 'x' }, ['title']);
  bad({ type: 'object', properties: { constructor: { type: 'string' } } }, ['properties.constructor']);
  bad({ type: 'object', properties: { ['x'.repeat(41)]: { type: 'string' } } }, [`properties.${'x'.repeat(41)}`]);
  bad({ type: 'object', properties: { _a: { type: 'string' } } }, ['properties._a']);
  bad(one({ type: 'string', title: 't'.repeat(81) }), ['properties.a.title']);
  bad(one({ type: 'string', description: 'd'.repeat(201) }), ['properties.a.description']);
  bad(one({ type: 'string', title: '' }), ['properties.a.title']);
  bad(one({ type: 'string', format: 'email' }), ['properties.a.format']);
  bad(one({ type: 'string', minimum: 1 }), ['properties.a.minimum']);
  bad(one({ type: 'number', maxLength: 3 }), ['properties.a.maxLength']);
  bad(one({ type: 'string', maxLength: 4097 }), ['properties.a.maxLength']);
  bad(one({ type: 'number', minimum: 5, maximum: 1 }), ['properties.a.minimum']);
  bad(one({ type: 'number', maximum: Infinity }), ['properties.a.maximum']);
  bad(one({ type: 'string', enum: [] }), ['properties.a.enum']);
  bad(one({ type: 'string', enum: Array.from({ length: 33 }, (_, i) => `v${i}`) }), ['properties.a.enum']);
  bad(one({ type: 'string', enum: ['x', 'x'] }), ['properties.a.enum']);
  bad(one({ type: 'integer', enum: [1, 1.5] }), ['properties.a.enum']);
  bad(one({ type: 'string', enum: ['x', 'y'], default: 'z' }), ['properties.a.default']);
  bad(one({ type: 'boolean', default: 'yes' }), ['properties.a.default']);
  bad(one({ type: 'integer', minimum: 2, default: 1 }), ['properties.a.default']);
  bad(one({ type: 'string', maxLength: 2, default: 'abc' }), ['properties.a.default']);
  bad(one({ type: 'null' }), ['properties.a.type']);
  bad(one('string'), ['properties.a']);
  bad({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, ['required.0']);
  bad({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] }, ['required']);
  // The caps are inclusive: 32 properties and an enum of 32 values pass.
  assert.equal(validateSchema({ type: 'object', properties: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, { type: 'string' }])) }).ok, true);
  assert.equal(validateSchema(one({ type: 'string', enum: Array.from({ length: 32 }, (_, i) => `v${i}`) })).ok, true);
  assert.equal(validateSchema(one({ type: 'string', maxLength: 4096 })).ok, true);
  bad({ type: 'object', properties: {}, required: 'a' }, ['required']);
  // Lengths are code points: 80 emoji is a legal title.
  assert.equal(validateSchema(one({ type: 'string', title: '🖍'.repeat(80) })).ok, true);
  assert.equal(validateSchema(one({ type: 'boolean', enum: [true, false] })).ok, true);
  assert.equal(validateSchema({ ...FULL, additionalProperties: false }).ok, true);
});

test('checkValue: a sound value passes, and an unknown key, a wrong type, a value outside enum/min/max/maxLength and a missing required key are refused', () => {
  assert.deepStrictEqual(checkValue(FULL, { name: 'pen', color: 'gold' }), { ok: true, errors: [] });
  assert.deepStrictEqual(checkValue(FULL, { name: 'pen', color: 'rust', width: 8, count: 1, shared: false, step: 4 }), { ok: true, errors: [] });
  const cases = [
    [{ name: 'pen', color: 'gold', extra: 1 }, 'extra', /not a setting/],
    [{ name: 3, color: 'gold' }, 'name', /must be a string/],
    [{ name: 'pen', color: 'gold', shared: 'yes' }, 'shared', /must be a boolean/],
    [{ name: 'pen', color: 'gold', count: 1.5 }, 'count', /must be an integer/],
    [{ name: 'pen', color: 'gold', width: NaN }, 'width', /must be a number/],
    [{ name: 'pen', color: 'purple' }, 'color', /must be one of "gold", "accent", "green", "rust"/],
    [{ name: 'pen', color: 'gold', width: 0.1 }, 'width', /at least 0.5/],
    [{ name: 'pen', color: 'gold', count: 10 }, 'count', /at most 9/],
    [{ name: 'x'.repeat(21), color: 'gold' }, 'name', /at most 20 characters/],
    [{ name: 'pen', color: 'gold', step: 3 }, 'step', /must be one of 1, 2, 4/],
    [{ color: 'gold' }, 'name', /is required/],
  ];
  for (const [value, p, re] of cases) {
    const r = checkValue(FULL, value);
    assert.equal(r.ok, false, JSON.stringify(value));
    assert.deepStrictEqual(paths(r), [p], JSON.stringify(r.errors));
    assert.match(r.errors[0].why, re);
  }
  for (const v of [null, [], 'x', 1]) assert.equal(checkValue(FULL, v).ok, false);
  // An inherited name is not a setting.
  assert.deepStrictEqual(paths(checkValue(FULL, { name: 'pen', color: 'gold', toString: 'x' })), ['toString']);
  // A schema validateSchema refuses answers one error.
  assert.deepStrictEqual(checkValue({ type: 'array' }, {}), { ok: false, errors: [{ path: '', why: 'the settings schema is not valid' }] });
});

test('the module is a leaf: no require(', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'settings-schema.js'), 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.equal(ss.MAX_PROPERTIES, 32);
  assert.deepStrictEqual([...ss.TYPES], ['string', 'number', 'integer', 'boolean']);
  assert.equal(ss.isKey('note'), true);
  assert.equal(ss.isKey('__proto__'), false);
});

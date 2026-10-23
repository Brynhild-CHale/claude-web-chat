// lib/core/settings-schema.js — THE settings-schema subset (annotation engine
// tranche 2, U335; PLAN.md 2D.5, DECISIONS.md I.6 "two levels of settings").
//
// An element type's manifest declares its settings as `settings: {small?,
// large?}` (lib/packs/elements.js toolbarFields), each a schema in exactly the
// subset the builtin `form-renderer` component renders
// (templates/components/form-renderer/meta.json: "an object root with
// string/number/integer/boolean/enum properties + required[]"), so the
// toolbar's settings frames can draw any schema a type ships through it and
// nothing a type ships can ask that renderer for a shape it does not have.
//
//   root      { type: 'object', properties, required?, additionalProperties? }
//             — additionalProperties may only be false (the subset is closed
//             either way: checkValue refuses an unknown key)
//   properties  at most MAX_PROPERTIES keys, each matching KEY_RE and never
//             one of the keys a toolbar record refuses (constructor, prototype;
//             __proto__ fails KEY_RE)
//   property  { type: 'string' | 'number' | 'integer' | 'boolean', title?
//             (≤ TITLE_MAX), description? (≤ DESCRIPTION_MAX), enum? (1 to
//             ENUM_MAX distinct primitives of its type), default?, minimum?,
//             maximum? (number and integer only), maxLength? (string only, an
//             integer 0 to MAX_LENGTH_MAX) } — and nothing else: no $ref, no
//             nested object, no array, no patternProperties
//   required  a list of distinct property keys
//
//   validateSchema(schema) → { ok, errors: [{path, why}] }
//       every problem at once; `path` is dotted from the root
//       ('properties.color.enum'), '' for the root itself.
//   checkValue(schema, value) → { ok, errors: [{path, why}] }
//       `value` a plain object, no unknown keys, each value of its property's
//       type, inside its enum and bounds, every `required` key present. A
//       schema validateSchema refuses answers { ok: false } with one error.
//
// Lengths are counted in code points. Pure, and IMPORTS NOTHING (core is the
// leaf layer, and this module is small enough to stay a leaf of the leaf).
// That is why the forbidden-character check is NOT here: a title, description
// or enum string holding a control, bidi or invisible character is refused by
// the CALLER, which runs lib/core/text hasForbidden over every string of a
// schema it accepts (lib/packs/elements.js does, for element.json).

const MAX_PROPERTIES = 32;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 200;
const ENUM_MAX = 32;
const MAX_LENGTH_MAX = 4096;

// A property key: a letter, then up to 39 letters, digits or underscores.
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
// Keys that pass KEY_RE but that a toolbar record refuses anywhere
// (lib/core/toolbar-record), so a setting under one could never be stored.
const REFUSED_KEYS = Object.freeze(['constructor', 'prototype']);

const TYPES = Object.freeze(['string', 'number', 'integer', 'boolean']);
const ROOT_KEYS = Object.freeze(['type', 'properties', 'required', 'additionalProperties']);
const PROPERTY_KEYS = Object.freeze(['type', 'title', 'description', 'enum', 'default', 'minimum', 'maximum', 'maxLength']);

const join = (base, key) => (base ? `${base}.${key}` : String(key));
const chars = (s) => [...s].length;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Whether `k` may name a property (and so a stored setting).
function isKey(k) {
  return typeof k === 'string' && KEY_RE.test(k) && !REFUSED_KEYS.includes(k);
}

// Whether `v` is a value of the schema type `type` (no enum or bounds).
function ofType(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'boolean': return typeof v === 'boolean';
    default: return false;
  }
}

// Why `type` is refused, naming what the subset lacks.
function typeRefusal(type) {
  if (type === 'object') return 'a nested object is not in the settings subset (string, number, integer, boolean)';
  if (type === 'array') return 'an array is not in the settings subset (string, number, integer, boolean)';
  return `"type" must be one of ${TYPES.join(', ')} (got ${JSON.stringify(type === undefined ? null : type)})`;
}

// The problems of one value against one (valid) property, each pushed onto
// `errors` at `path`.
function valueProblems(spec, v, path, errors) {
  if (!ofType(spec.type, v)) {
    errors.push({ path, why: `must be ${spec.type === 'integer' ? 'an integer' : `a ${spec.type}`}` });
    return;
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
    errors.push({ path, why: `must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  if (typeof spec.minimum === 'number' && v < spec.minimum) errors.push({ path, why: `must be at least ${spec.minimum}` });
  if (typeof spec.maximum === 'number' && v > spec.maximum) errors.push({ path, why: `must be at most ${spec.maximum}` });
  if (typeof spec.maxLength === 'number' && chars(v) > spec.maxLength) errors.push({ path, why: `at most ${spec.maxLength} characters` });
}

function validateProperty(spec, path, errors) {
  if (!isPlainObject(spec)) {
    errors.push({ path, why: 'a property must be an object' });
    return;
  }
  for (const k of Object.keys(spec)) {
    if (PROPERTY_KEYS.includes(k)) continue;
    if (k === '$ref') errors.push({ path: join(path, k), why: '$ref is not in the settings subset' });
    else if (k === 'properties' || k === 'items' || k === 'patternProperties' || k === 'additionalProperties') {
      errors.push({ path: join(path, k), why: `"${k}" is not in the settings subset (no nested object or array)` });
    } else errors.push({ path: join(path, k), why: `"${k}" is not a key of the settings subset (${PROPERTY_KEYS.join(', ')})` });
  }
  const typeOk = TYPES.includes(spec.type);
  if (!typeOk) errors.push({ path: join(path, 'type'), why: typeRefusal(spec.type) });
  for (const [k, max] of [['title', TITLE_MAX], ['description', DESCRIPTION_MAX]]) {
    if (spec[k] === undefined) continue;
    if (typeof spec[k] !== 'string' || !spec[k].length) errors.push({ path: join(path, k), why: 'must be a non-empty string' });
    else if (chars(spec[k]) > max) errors.push({ path: join(path, k), why: `at most ${max} characters` });
  }
  const numeric = spec.type === 'number' || spec.type === 'integer';
  for (const k of ['minimum', 'maximum']) {
    if (spec[k] === undefined) continue;
    if (!numeric) errors.push({ path: join(path, k), why: `only a number or integer property takes "${k}"` });
    else if (typeof spec[k] !== 'number' || !Number.isFinite(spec[k])) errors.push({ path: join(path, k), why: 'must be a finite number' });
  }
  if (typeof spec.minimum === 'number' && typeof spec.maximum === 'number' && spec.minimum > spec.maximum) {
    errors.push({ path: join(path, 'minimum'), why: 'must not be above "maximum"' });
  }
  if (spec.maxLength !== undefined) {
    if (spec.type !== 'string') errors.push({ path: join(path, 'maxLength'), why: 'only a string property takes "maxLength"' });
    else if (!Number.isSafeInteger(spec.maxLength) || spec.maxLength < 0 || spec.maxLength > MAX_LENGTH_MAX) {
      errors.push({ path: join(path, 'maxLength'), why: `must be an integer from 0 to ${MAX_LENGTH_MAX}` });
    }
  }
  let enumOk = true;
  if (spec.enum !== undefined) {
    const e = spec.enum;
    if (!Array.isArray(e) || !e.length || e.length > ENUM_MAX) {
      errors.push({ path: join(path, 'enum'), why: `must be a list of 1 to ${ENUM_MAX} values` });
      enumOk = false;
    } else if (typeOk && !e.every((x) => ofType(spec.type, x))) {
      errors.push({ path: join(path, 'enum'), why: `every value must be ${spec.type === 'integer' ? 'an integer' : `a ${spec.type}`} (the property's type)` });
      enumOk = false;
    } else if (new Set(e).size !== e.length) {
      errors.push({ path: join(path, 'enum'), why: 'must not list a value twice' });
      enumOk = false;
    }
  }
  if (spec.default !== undefined && typeOk && enumOk) {
    const before = errors.length;
    valueProblems(spec, spec.default, join(path, 'default'), errors);
    for (let i = before; i < errors.length; i++) errors[i] = { ...errors[i], why: `the default ${errors[i].why}` };
  }
}

function validateSchema(schema) {
  const errors = [];
  if (!isPlainObject(schema)) return { ok: false, errors: [{ path: '', why: 'a settings schema must be an object' }] };
  for (const k of Object.keys(schema)) {
    if (ROOT_KEYS.includes(k)) continue;
    if (k === '$ref') errors.push({ path: k, why: '$ref is not in the settings subset' });
    else if (k === 'patternProperties' || k === 'items') errors.push({ path: k, why: `"${k}" is not in the settings subset` });
    else errors.push({ path: k, why: `"${k}" is not a root key of the settings subset (${ROOT_KEYS.join(', ')})` });
  }
  if (schema.type !== 'object') {
    errors.push({ path: 'type', why: `the root's "type" must be "object" (got ${JSON.stringify(schema.type === undefined ? null : schema.type)})` });
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    errors.push({ path: 'additionalProperties', why: 'may only be false (the settings subset is closed)' });
  }
  const props = schema.properties;
  let keys = [];
  if (!isPlainObject(props)) {
    errors.push({ path: 'properties', why: 'must be an object of properties' });
  } else {
    keys = Object.keys(props);
    if (keys.length > MAX_PROPERTIES) errors.push({ path: 'properties', why: `at most ${MAX_PROPERTIES} properties (got ${keys.length})` });
    for (const k of keys) {
      const p = join('properties', k);
      if (!isKey(k)) {
        errors.push({ path: p, why: 'a property key is a letter then up to 39 letters, digits or _ (and never constructor or prototype)' });
        continue;
      }
      validateProperty(props[k], p, errors);
    }
  }
  if (schema.required !== undefined) {
    const r = schema.required;
    if (!Array.isArray(r)) errors.push({ path: 'required', why: 'must be a list of property keys' });
    else {
      r.forEach((k, i) => {
        if (typeof k !== 'string' || !keys.includes(k)) errors.push({ path: `required.${i}`, why: `${JSON.stringify(k)} is not a property` });
      });
      if (new Set(r).size !== r.length) errors.push({ path: 'required', why: 'must not list a key twice' });
    }
  }
  return { ok: errors.length === 0, errors };
}

function checkValue(schema, value) {
  if (!validateSchema(schema).ok) return { ok: false, errors: [{ path: '', why: 'the settings schema is not valid' }] };
  if (!isPlainObject(value)) return { ok: false, errors: [{ path: '', why: 'settings must be an object' }] };
  const errors = [];
  const props = schema.properties;
  for (const k of Object.keys(value)) {
    if (!Object.hasOwn(props, k)) {
      errors.push({ path: k, why: 'is not a setting of this schema' });
      continue;
    }
    if (value[k] === undefined) continue;
    valueProblems(props[k], value[k], k, errors);
  }
  for (const k of schema.required || []) {
    if (!Object.hasOwn(value, k) || value[k] === undefined) errors.push({ path: k, why: 'is required' });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  MAX_PROPERTIES, TITLE_MAX, DESCRIPTION_MAX, ENUM_MAX, MAX_LENGTH_MAX, KEY_RE, TYPES,
  isKey, validateSchema, checkValue,
};

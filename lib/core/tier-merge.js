// The per-key tier merge: the one home of the rule "a more specific tier
// overrides a less specific one KEY BY KEY, and the answer says which tier won
// and what it shadowed" (annotation engine, PLAN.md 2D.1; DECISIONS.md I.6
// addendum 1: a project record overrides the user record key by key, the user
// tier the default beneath).
//
// The toolbar's bindings and settings use it on both sides of the wire: the
// daemon merges user + project (U332), the chrome merges default + user +
// project (U333) through the served copy below, so there is never a second
// implementation. Nested use is the caller's: settings merge per field by
// calling mergeByKey once per tool type over its payloads.
//
// NOT this engine's rule: lib/core/resources (name-keyed, first tier wins over
// directories), lib/server/theme (a per-token assign with no provenance) and
// lib/toggle (most restrictive wins) keep their own, different rules.
//
//   mergeByKey(layers)   layers: [{tier, record}, ...] LEAST specific first.
//                        tier: a non-empty string, unique within the call.
//                        record: a plain object, or null / undefined (an
//                        empty tier). Returns a frozen object, keys sorted:
//                        {[key]: {value, tier, shadows: [{tier, value}, ...]}}
//                        value/tier from the most specific tier holding the
//                        key; shadows the less specific tiers holding it, most
//                        specific first. A value of undefined is ABSENT at its
//                        tier (falls through); an explicit null is a value and
//                        wins (a project-tier null unbinds the user tier's
//                        binding). Values are handed back by reference, never
//                        cloned or mutated; the layers are never mutated.
//   effective(merged)    a frozen {key: value} without the null entries (the
//                        map a dispatcher reads).
//   tiersOf(merged, key) the tiers holding key, most specific first (frozen).
//
// The keys __proto__, constructor and prototype are refused (a TypeError
// naming the tier): records come off disk from a committable directory.
// Keys are sorted by code unit, but a JavaScript object enumerates its
// integer-like keys ("1", "10") first, in numeric order, whatever the
// insertion order: the output is deterministic either way.
//
// AUTHORING RULE: this file depends on nothing at all, not even lib/core. Each
// exported function is self-contained (no helper outside its own body, no
// module-level constant), because browserModuleSource() assembles the browser
// copy from their own toString(). test/tier-merge.test.js holds both rules.
'use strict';

function mergeByKey(layers) {
  const REFUSED = ['__proto__', 'constructor', 'prototype'];
  if (!Array.isArray(layers)) throw new TypeError('mergeByKey: layers must be an array of {tier, record}');
  const tiers = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer || typeof layer !== 'object') {
      throw new TypeError(`mergeByKey: layer ${i} must be an object {tier, record}`);
    }
    const tier = layer.tier;
    if (typeof tier !== 'string' || tier === '') {
      throw new TypeError(`mergeByKey: layer ${i} needs a non-empty string tier`);
    }
    if (tiers.indexOf(tier) >= 0) throw new TypeError(`mergeByKey: the tier '${tier}' is named twice`);
    tiers.push(tier);
    const record = layer.record;
    if (record == null) continue;
    const proto = typeof record === 'object' ? Object.getPrototypeOf(record) : undefined;
    const plain = typeof record === 'object' && !Array.isArray(record)
      && (proto === null || (Object.prototype.toString.call(record) === '[object Object]'
        && Object.getPrototypeOf(proto) === null));
    if (!plain) {
      throw new TypeError(`mergeByKey: the tier '${tier}' record must be a plain object, null or undefined`);
    }
    for (const key of Object.keys(record)) {
      if (REFUSED.indexOf(key) >= 0) {
        throw new TypeError(`mergeByKey: the tier '${tier}' record holds the refused key '${key}'`);
      }
    }
  }
  // Most specific first: the first tier met that holds a key wins it, and
  // every later one is shadowed by it.
  const found = new Map();
  for (let i = layers.length - 1; i >= 0; i--) {
    const record = layers[i].record;
    if (record == null) continue;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value === undefined) continue;
      const hit = { tier: layers[i].tier, value: value };
      const list = found.get(key);
      if (list) list.push(hit); else found.set(key, [hit]);
    }
  }
  const keys = Array.from(found.keys());
  keys.sort();
  const out = {};
  for (const key of keys) {
    const list = found.get(key);
    const shadows = [];
    for (let j = 1; j < list.length; j++) shadows.push(Object.freeze({ tier: list[j].tier, value: list[j].value }));
    out[key] = Object.freeze({ value: list[0].value, tier: list[0].tier, shadows: Object.freeze(shadows) });
  }
  return Object.freeze(out);
}

function effective(merged) {
  if (!merged || typeof merged !== 'object') throw new TypeError('effective: takes what mergeByKey returned');
  const out = {};
  for (const key of Object.keys(merged)) {
    const entry = merged[key];
    if (entry && entry.value !== null) out[key] = entry.value;
  }
  return Object.freeze(out);
}

function tiersOf(merged, key) {
  if (!merged || typeof merged !== 'object') throw new TypeError('tiersOf: takes what mergeByKey returned');
  if (!Object.prototype.hasOwnProperty.call(merged, key)) return Object.freeze([]);
  const entry = merged[key];
  const out = [entry.tier];
  for (const s of entry.shadows) out.push(s.tier);
  return Object.freeze(out);
}

// The browser copy: an ES module assembled from the three functions' own
// source, on lib/core/markdown's precedent, so there is no second
// implementation to keep in step. Served by lib/server/routes/page.js at
// /app/tier-merge.js (and to the jsdom tests by test-support/served-modules).
// Memoised for the process's life: an edit here needs a daemon restart AND a
// browser refresh.
let browserSrc = null;
function browserModuleSource() {
  if (browserSrc == null) {
    browserSrc = [
      '// Generated from lib/core/tier-merge.js — do not edit; see that file.',
      `export const mergeByKey = ${mergeByKey.toString()};`,
      `export const effective = ${effective.toString()};`,
      `export const tiersOf = ${tiersOf.toString()};`,
      '',
    ].join('\n');
  }
  return browserSrc;
}

module.exports = { mergeByKey, effective, tiersOf, browserModuleSource };

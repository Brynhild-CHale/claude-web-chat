// The per-key tier merge (annotation engine, PLAN.md 2D.1): lib/core/tier-merge,
// the one home of "a more specific tier overrides a less specific one key by
// key, keeping which tier won and what it shadowed", served to the chrome as
// /app/tier-merge.js. Pinned:
//   - mergeByKey / effective / tiersOf as the brief states, the explicit-null
//     unbind and the refused prototype keys included;
//   - a property suite on a seeded PRNG (the seed is printed on failure);
//   - the module depends on nothing, and its browser copy (assembled from the
//     functions' own source) answers as the CommonJS one does;
//   - GET /app/tier-merge.js serves that copy under the existing /app/* row,
//     and the jsdom tests resolve ./tier-merge.js through served-modules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const tm = require('../lib/core/tier-merge');
const { mergeByKey, effective, tiersOf, browserModuleSource } = tm;
const { classify } = require('../lib/core/remote-policy');
const { withServer } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(REPO, 'lib/core/tier-merge.js'), 'utf8');
const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));
// A frozen answer compares through a plain copy (deepStrictEqual is fine with
// frozen objects; the copy only strips nothing and keeps the message readable).
const plain = (o) => JSON.parse(JSON.stringify(o));

// ── the brief's cases ────────────────────────────────────────────────────

const D_U_P = [
  { tier: 'default', record: { a: 1, b: 2 } },
  { tier: 'user', record: { b: 3 } },
  { tier: 'project', record: { b: null, c: 4 } },
];

test('mergeByKey: the most specific tier wins each key; a project null unbinds and shadows the rest', () => {
  const merged = mergeByKey(D_U_P);
  assert.deepStrictEqual(plain(merged), {
    a: { value: 1, tier: 'default', shadows: [] },
    b: { value: null, tier: 'project', shadows: [{ tier: 'user', value: 3 }, { tier: 'default', value: 2 }] },
    c: { value: 4, tier: 'project', shadows: [] },
  });
});

test('effective drops the null entries; tiersOf lists the holding tiers, most specific first', () => {
  const merged = mergeByKey(D_U_P);
  assert.deepStrictEqual({ ...effective(merged) }, { a: 1, c: 4 });
  assert.ok(Object.isFrozen(effective(merged)));
  assert.deepStrictEqual([...tiersOf(merged, 'b')], ['project', 'user', 'default']);
  assert.deepStrictEqual([...tiersOf(merged, 'a')], ['default']);
  assert.deepStrictEqual([...tiersOf(merged, 'nope')], []);
  assert.deepStrictEqual([...tiersOf(merged, 'toString')], [], 'an inherited name is not a key');
  assert.ok(Object.isFrozen(tiersOf(merged, 'b')));
});

test('a key whose value is undefined at the project tier falls through to the user tier', () => {
  const merged = mergeByKey([
    { tier: 'user', record: { k: 'u' } },
    { tier: 'project', record: { k: undefined, j: 1 } },
  ]);
  assert.deepStrictEqual(plain(merged.k), { value: 'u', tier: 'user', shadows: [] });
  assert.deepStrictEqual([...tiersOf(merged, 'k')], ['user']);
  // Undefined at every tier: no key at all.
  const none = mergeByKey([{ tier: 'project', record: { k: undefined } }]);
  assert.deepStrictEqual(Object.keys(none), []);
});

test('a null record and an undefined record are empty tiers; a tier may still be named', () => {
  const merged = mergeByKey([
    { tier: 'default', record: { a: 1 } },
    { tier: 'user', record: null },
    { tier: 'project', record: undefined },
    { tier: 'device' },
  ]);
  assert.deepStrictEqual(plain(merged), { a: { value: 1, tier: 'default', shadows: [] } });
  assert.deepStrictEqual(plain(mergeByKey([])), {});
  assert.deepStrictEqual(plain(mergeByKey([{ tier: 't', record: Object.create(null) }])), {});
});

test('values are handed back by reference, never cloned', () => {
  const obj = { keys: ['x'] };
  const lower = { nested: true };
  const merged = mergeByKey([{ tier: 'user', record: { k: lower } }, { tier: 'project', record: { k: obj } }]);
  assert.strictEqual(merged.k.value, obj);
  assert.strictEqual(merged.k.shadows[0].value, lower);
  assert.strictEqual(effective(merged).k, obj);
  assert.ok(!Object.isFrozen(obj), 'a value is never frozen by the merge');
});

const throwsNaming = (fn, tier, re) => assert.throws(fn, (e) => {
  assert.ok(e instanceof TypeError, `a TypeError, got ${e && e.name}`);
  assert.ok(e.message.includes(`'${tier}'`), `names the tier '${tier}': ${e.message}`);
  if (re) assert.match(e.message, re);
  return true;
});

test('a repeated tier name throws a TypeError naming it', () => {
  throwsNaming(() => mergeByKey([{ tier: 'user', record: {} }, { tier: 'user', record: null }]), 'user', /twice/);
});

test('a record that is an array, a string, a number (or another non-plain object) throws naming its tier', () => {
  for (const bad of [[1, 2], [], 'str', 42, true, new Date(0), new Map(), () => 1]) {
    throwsNaming(() => mergeByKey([{ tier: 'ok', record: {} }, { tier: 'project', record: bad }]), 'project', /plain object/);
  }
});

test('a record holding __proto__, constructor or prototype throws naming its tier', () => {
  const recs = [
    JSON.parse('{"__proto__":1}'),
    JSON.parse('{"a":1,"constructor":{"x":1}}'),
    { prototype: null },
    { constructor: undefined },
  ];
  for (const rec of recs) {
    throwsNaming(() => mergeByKey([{ tier: 'user', record: rec }]), 'user', /refused key/);
  }
  assert.equal(({}).polluted, undefined);
});

test('layers that are not an array, or a layer without a non-empty string tier, throw TypeErrors', () => {
  for (const bad of [null, undefined, {}, 'x']) assert.throws(() => mergeByKey(bad), TypeError);
  for (const bad of [null, 1, {}, { tier: '' }, { tier: 3, record: {} }]) {
    assert.throws(() => mergeByKey([bad]), TypeError);
  }
  assert.throws(() => effective(null), TypeError);
  assert.throws(() => tiersOf(undefined, 'k'), TypeError);
});

// ── the property suite ────────────────────────────────────────────────────

const SEED = Number(process.env.WEB_CHAT_TIER_MERGE_SEED || 0x2d1c331);
const CASES = 500;

// mulberry32: a small, well-mixed 32-bit PRNG; the same seed, the same cases.
function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Keys never integer-like, so code-unit order IS enumeration order (an object
// lists integer-like keys first, numerically, whatever the merge does).
const KEY_POOL = ['a', 'b', 'c', 'ctrl+1', 'shift+K', 'Z', 'k.dot', 'k-dash', 'slot_2', 'comment', 'highlight', 'é', 'x y'];

function genValue(r) {
  const p = r();
  if (p < 0.15) return null;
  if (p < 0.2) return undefined;
  if (p < 0.45) return Math.floor(r() * 1000) - 500;
  if (p < 0.7) return `s${Math.floor(r() * 50)}`;
  return { n: Math.floor(r() * 9), tag: `t${Math.floor(r() * 5)}` };
}

function genCase(r) {
  const nTiers = 1 + Math.floor(r() * 4);
  const layers = [];
  for (let i = 0; i < nTiers; i++) {
    const kind = r();
    if (kind < 0.08) { layers.push({ tier: `t${i}`, record: kind < 0.04 ? null : undefined }); continue; }
    const nKeys = Math.floor(r() * 13);
    const record = {};
    for (let k = 0; k < nKeys; k++) record[KEY_POOL[Math.floor(r() * KEY_POOL.length)]] = genValue(r);
    layers.push({ tier: `t${i}`, record });
  }
  return layers;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// The defined values of key across the layers, most specific first.
function definers(layers, key) {
  const out = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const rec = layers[i].record;
    if (rec && Object.prototype.hasOwnProperty.call(rec, key) && rec[key] !== undefined) {
      out.push({ tier: layers[i].tier, value: rec[key] });
    }
  }
  return out;
}

// The two lower tiers folded into one record, nulls kept (so a fold is a tier).
function effectiveWithNulls(lo, hi) {
  const merged = mergeByKey([{ tier: 'lo', record: lo }, { tier: 'hi', record: hi }]);
  const out = {};
  for (const k of Object.keys(merged)) out[k] = merged[k].value;
  return out;
}

function cases() {
  const r = prng(SEED);
  const out = [];
  for (let i = 0; i < CASES; i++) out.push(genCase(r));
  return out;
}

function withSeed(t, fn) {
  try { fn(); } catch (e) {
    t.diagnostic(`tier-merge property seed: ${SEED} (rerun with WEB_CHAT_TIER_MERGE_SEED=${SEED})`);
    e.message = `[seed ${SEED}] ${e.message}`;
    throw e;
  }
}

test(`property: ${CASES} seeded cases — value, shadows, one-tier, associativity, order and freezing`, (t) => {
  withSeed(t, () => {
    for (const [n, layers] of cases().entries()) {
      const where = `case ${n}: ${JSON.stringify(layers)}`;
      const snapshot = JSON.stringify(layers);
      deepFreeze(layers);
      const merged = mergeByKey(layers);
      // (6) deep-frozen inputs are unchanged, and nothing threw under strict mode.
      assert.equal(JSON.stringify(layers), snapshot, `${where}: inputs unchanged`);

      const allKeys = new Set();
      for (const l of layers) if (l.record) for (const k of Object.keys(l.record)) allKeys.add(k);
      for (const key of allKeys) {
        const defs = definers(layers, key);
        if (!defs.length) { assert.ok(!Object.prototype.hasOwnProperty.call(merged, key), `${where}: ${key} absent`); continue; }
        const e = merged[key];
        // (1) the most specific defined value, by reference.
        assert.strictEqual(e.value, defs[0].value, `${where}: ${key} value`);
        assert.equal(e.tier, defs[0].tier, `${where}: ${key} tier`);
        // (2) exactly the less specific definers, most specific first.
        assert.deepStrictEqual(e.shadows.map((s) => s.tier), defs.slice(1).map((d) => d.tier), `${where}: ${key} shadows`);
        e.shadows.forEach((s, i) => assert.strictEqual(s.value, defs[i + 1].value, `${where}: ${key} shadow ${i}`));
        assert.deepStrictEqual([...tiersOf(merged, key)], defs.map((d) => d.tier), `${where}: ${key} tiersOf`);
      }
      // (5) keys sorted; the result, each entry, its shadows and each shadow frozen.
      const keys = Object.keys(merged);
      assert.deepStrictEqual(keys, [...keys].sort(), `${where}: keys sorted`);
      assert.ok(Object.isFrozen(merged), `${where}: result frozen`);
      for (const k of keys) {
        assert.ok(Object.isFrozen(merged[k]) && Object.isFrozen(merged[k].shadows), `${where}: ${k} frozen`);
        for (const s of merged[k].shadows) assert.ok(Object.isFrozen(s), `${where}: ${k} shadow frozen`);
      }
      // effective: exactly the non-null winners.
      const eff = effective(merged);
      assert.deepStrictEqual(Object.keys(eff), keys.filter((k) => merged[k].value !== null), `${where}: effective keys`);
      for (const k of Object.keys(eff)) assert.strictEqual(eff[k], merged[k].value);

      // (3) one tier: every key, shadows [].
      for (const l of layers) {
        const one = mergeByKey([l]);
        for (const k of Object.keys(one)) {
          assert.equal(one[k].tier, l.tier);
          assert.deepStrictEqual(one[k].shadows, []);
        }
        const defined = l.record ? Object.keys(l.record).filter((k) => l.record[k] !== undefined).sort() : [];
        assert.deepStrictEqual(Object.keys(one), defined, `${where}: one tier ${l.tier} gives every defined key`);
      }

      // (4) folding is associative: d+u folded first, then p, gives the same map.
      if (layers.length === 3) {
        const [d, u, p] = layers;
        const folded = mergeByKey([{ tier: 'du', record: effectiveWithNulls(d.record, u.record) }, p]);
        assert.deepStrictEqual({ ...effective(folded) }, { ...eff }, `${where}: associative`);
      }
    }
  });
});

// ── the module and its browser copy ───────────────────────────────────────

test('the module depends on nothing: no require( and no import in lib/core/tier-merge.js', () => {
  assert.doesNotMatch(SOURCE, /\brequire\s*\(/);
  assert.doesNotMatch(SOURCE, /\bimport\b/);
});

test('browserModuleSource: memoised, imports nothing, exports mergeByKey, effective and tiersOf', async () => {
  const src = browserModuleSource();
  assert.equal(typeof src, 'string');
  assert.strictEqual(browserModuleSource(), src, 'the same string on a second call');
  assert.match(src, /^\/\/ Generated from lib\/core\/tier-merge\.js — do not edit/);
  assert.doesNotMatch(src, /\bimport\b/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  const mod = await importSource(src);
  assert.deepStrictEqual(Object.keys(mod).sort(), ['effective', 'mergeByKey', 'tiersOf']);
  for (const n of ['mergeByKey', 'effective', 'tiersOf']) assert.equal(typeof mod[n], 'function', n);
});

test('the browser copy answers as the CommonJS one on the brief\'s case, the refusals and every property case', async (t) => {
  const mod = await importSource(browserModuleSource());
  const m = mod.mergeByKey(D_U_P);
  assert.deepStrictEqual(plain(m), plain(mergeByKey(D_U_P)));
  assert.deepStrictEqual({ ...mod.effective(m) }, { a: 1, c: 4 });
  assert.deepStrictEqual([...mod.tiersOf(m, 'b')], ['project', 'user', 'default']);
  throwsNaming(() => mod.mergeByKey([{ tier: 'user', record: JSON.parse('{"__proto__":1}') }]), 'user');
  throwsNaming(() => mod.mergeByKey([{ tier: 'x', record: null }, { tier: 'x', record: null }]), 'x');
  withSeed(t, () => {
    for (const [n, layers] of cases().entries()) {
      // Compared through JSON with undefined kept distinct from absent.
      const a = mod.mergeByKey(layers);
      const b = mergeByKey(layers);
      assert.deepStrictEqual(Object.keys(a), Object.keys(b), `case ${n}: keys`);
      for (const k of Object.keys(b)) {
        assert.strictEqual(a[k].value, b[k].value, `case ${n}: ${k}`);
        assert.equal(a[k].tier, b[k].tier);
        assert.deepStrictEqual(plain(a[k].shadows), plain(b[k].shadows));
      }
      assert.deepStrictEqual({ ...mod.effective(a) }, { ...effective(b) });
    }
  });
});

// ── the served module ─────────────────────────────────────────────────────

test('GET /app/tier-merge.js serves browserModuleSource() as JavaScript', async (t) => {
  const { port } = await withServer(t);
  const res = await fetch(`http://localhost:${port}/app/tier-merge.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
  assert.strictEqual(await res.text(), browserModuleSource());
});

test('/app/tier-merge.js is reachable under the existing /app/* remote-policy row', () => {
  assert.equal(classify('GET', '/app/tier-merge.js').allow, true);
});

test('the jsdom tests resolve ./tier-merge.js through served-modules (no file on disk)', async () => {
  const file = path.join(REPO, 'public/app/tier-merge.js');
  assert.equal(fs.existsSync(file), false, 'public/app/tier-merge.js is served, never written');
  const url = pathToFileURL(file).href;
  // A chrome module's relative import, as bootShell's chrome resolves it.
  const served = require('../test-support/served-modules');
  const parentURL = pathToFileURL(path.join(REPO, 'public/app/main.js')).href;
  const resolved = served.resolve('./tier-merge.js', { parentURL }, () => { throw new Error('fell through'); });
  assert.deepStrictEqual(resolved, { url, format: 'module', shortCircuit: true });
  const loaded = served.load(url, {}, () => { throw new Error('fell through'); });
  assert.strictEqual(loaded.source, browserModuleSource());
  // And the import itself (chrome-shell's importApp takes this path).
  const mod = await import(url);
  assert.deepStrictEqual({ ...mod.effective(mod.mergeByKey(D_U_P)) }, { a: 1, c: 4 });
});

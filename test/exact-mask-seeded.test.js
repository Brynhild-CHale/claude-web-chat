'use strict';

// U589 (H.9; corrective to U415c/U415e): the exact masking over a SEEDED
// value set. test/element-routes.test.js 'a page range pin beside a value
// learned later' minted its value with crypto.randomBytes and failed about 1
// run in 22 on Node 22.23.3, serving a comment's exact 'Use wcctx…' with the
// value's head unmasked. This file builds the route test's three range quotes
// (beside, across, into) over 200 deterministic values and runs them through
// the read view itself — the element store's record() for a highlight, its
// maskPins for a comment — with the value learned after the write, asserting
// findLeaks finds no fragment of it in exact, prefix or suffix for any seed
// (and the same over two cuts whose exact opens inside the value: step 4).
//
// At 503b8f2f every seed passes (and 5,000 more did, ad hoc): the masking
// rule is not value-shape dependent. The flake was the route test's own
// timing — the redactor consults the capture token's file lazily, at most
// every 2 s, and the poll's GET that first saw the highlight's note masked
// could straddle that consult, the comment (served first) read through the
// set before it. The route test now asserts on a fresh GET (U589's hand-off).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpRoot } = require('../test-support/helpers');
const { findLeaks } = require('../test-support/fake-secrets');
const { SCHEMAS } = require('../lib/core/element-log');
const { createRedactor, marksIn } = require('../lib/core/redact');
const { createElementStore, maskQuoteContext } = require('../lib/server/domain/elements');

const SEEDS = 200;
// The route test's value: 'wcctx' and 24 hex characters (12 random bytes).
const seeded = (i) => `wcctx${crypto.createHash('sha256').update(`seed:${i}`).digest('hex').slice(0, 24)}`;
const HIGHLIGHT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'highlight');

// The route test's text and its three range anchors (32 characters of context
// each side, as the chrome cuts one).
function quotesOf(value) {
  const text = `Use ${value} for access to the staging host now.`;
  const range = (exact) => {
    const i = text.indexOf(exact);
    const quote = { exact, prefix: text.slice(Math.max(0, i - 32), i), suffix: text.slice(i + exact.length, i + exact.length + 32) };
    return { v: 1, kind: 'range', mount: 'm-ctx', quote, pos: { start: i, end: i + exact.length } };
  };
  return {
    beside: range('to the staging host'),
    across: range(`Use ${value.slice(0, 12)}`),
    into: range(`Use ${value.slice(0, 4)}`),
  };
}

// Two more cuts over the same text, for step 4 (maskExact) — the learned
// fragment INSIDE exact, which the three above never reach: exact wholly
// inside the value, and exact opening on the value's tail.
function exactCutsOf(value) {
  const text = `Use ${value} for access to the staging host now.`;
  const at = (start, end) => {
    const exact = text.slice(start, end);
    const quote = { exact, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32) };
    return { v: 1, kind: 'range', mount: 'm-ctx', quote, pos: { start, end } };
  };
  return {
    inside: at(4 + 6, 4 + 20),
    tailIn: at(4 + 12, 4 + value.length + 11),
  };
}

// One store over one redactor: the daemon's shape — a writer token known from
// the start, the capture token a known SOURCE — with the source consulted on
// every call (maxAgeMs 0), so `learn(v)` swaps the learned value at once and
// a seed never sees another seed's value.
function world(t) {
  const root = tmpRoot('wc-u589-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const redactor = createRedactor();
  redactor.addKnown(crypto.createHash('sha256').update('writer').digest('hex'), 'writer-token');
  let current = null;
  redactor.addKnownSource(() => current, 'capture-token', { maxAgeMs: 0 });
  const file = path.join(root, '.web-chat', 'elements.jsonl');
  const store = createElementStore({ paths: { elementsLog: file }, state: { comments: [] }, graph: null, redactor, bootId: 'u589:1' });
  t.after(() => { try { store.close(); } catch {} });
  const bytes = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  return { redactor, store, bytes, learn: (v) => { current = v; } };
}

// The three quote fields of a served anchor, as one string for findLeaks.
const fields = (q) => JSON.stringify({ exact: q.exact, prefix: q.prefix, suffix: q.suffix });

test('seeded values: 200 values × the three range quotes (and two cuts inside the value) through the read view (record and maskPins), learned after the write, serve no fragment of the value in exact, prefix or suffix; the log bytes are unchanged', (t) => {
  const w = world(t);
  const failed = [];
  for (let i = 0; i < SEEDS; i++) {
    const value = seeded(i);
    const LEARNED = [{ id: 'learned', rule: 'known', secrets: [value] }];
    const quotes = { ...quotesOf(value), ...exactCutsOf(value) };
    // Written while the value is unknown: stored as written.
    w.learn(null);
    const written = {};
    for (const [name, anchor] of Object.entries(quotes)) {
      const rec = w.store.addElement({ type: 'highlight', schema: HIGHLIGHT, payload: { anchor, shared: true, color: null, note: null } });
      assert.equal(rec.anchor.quote.exact, anchor.quote.exact, `seed ${i} ${name}: stored as written`);
      written[name] = rec;
    }
    const pins = Object.entries(quotes).map(([name, anchor]) => ({ id: `c-${i}-${name}`, name, text: 'a pin', shared: true, anchor, replies: [] }));
    const before = w.bytes();
    w.learn(value);
    // The highlight's record (the log's view, then the context mask).
    for (const [name, rec] of Object.entries(written)) {
      const served = w.store.record(rec.id, rec.v).anchor.quote;
      if (findLeaks(fields(served), LEARNED).length) failed.push({ seed: i, path: 'record', name, value, served });
    }
    // A comment's pin (maskPins: the redactor over the anchor, then the mask).
    for (const p of w.store.maskPins(pins)) {
      const served = p.anchor.quote;
      if (findLeaks(fields(served), LEARNED).length) failed.push({ seed: i, path: 'maskPins', name: p.name, value, served });
    }
    assert.equal(w.bytes(), before, `seed ${i}: serving rewrites nothing (C1)`);
    for (const p of pins) assert.deepEqual(p.anchor, quotes[p.name], `seed ${i}: the live pin is unchanged`);
  }
  assert.deepEqual(failed, [], `seeds serving a fragment: ${failed.length}/${SEEDS * 10}\n${failed.slice(0, 5).map((f) => JSON.stringify(f)).join('\n')}`);
});

test('seeded values: the masked shapes hold for every seed — across masks exact\'s head and serves the suffix after the value; into cuts its suffix at the value under one mark; beside drops the prefix\'s tail of it', () => {
  const r = createRedactor();
  r.addKnown(crypto.createHash('sha256').update('writer').digest('hex'), 'writer-token');
  let current = null;
  r.addKnownSource(() => current, 'capture-token', { maxAgeMs: 0 });
  // The context mask's redaction as the store builds it (contextRedact).
  const red = Object.assign((s) => r.text(s), { tailAt: (s) => r.knownTailAt(s), fragmentAt: (s) => r.knownFragmentAt(s) });
  for (let i = 0; i < SEEDS; i++) {
    const value = seeded(i);
    const q = quotesOf(value);
    current = value;
    const serve = (a) => maskQuoteContext(r.value(a.quote), red, { masked: true });
    const across = serve(q.across);
    assert.ok(marksIn(across.exact).length === 1 && across.exact.startsWith('Use ‹'), `seed ${i} across: exact's head masked: ${JSON.stringify(across.exact)}`);
    assert.ok(q.across.quote.suffix.endsWith(across.suffix.slice(marksIn(across.suffix)[0] ? marksIn(across.suffix)[0].end : 0)) && across.suffix.includes('for access'), `seed ${i} across: the suffix keeps the words after the value: ${JSON.stringify(across.suffix)}`);
    const into = serve(q.into);
    const spelled = marksIn(into.suffix);
    assert.ok(spelled.length === 1 && spelled[0].start === 0 && into.suffix.slice(spelled[0].end) === q.into.quote.suffix.slice(value.length - 4), `seed ${i} into: the suffix cut at the value under one mark: ${JSON.stringify(into.suffix)}`);
    const beside = serve(q.beside);
    assert.ok(q.beside.quote.prefix.endsWith(beside.prefix) && beside.prefix.includes('for access') && !beside.prefix.includes(value.slice(-8)), `seed ${i} beside: the prefix keeps the words beside the passage: ${JSON.stringify(beside.prefix)}`);
    assert.equal(beside.exact, q.beside.quote.exact, `seed ${i} beside: exact untouched`);
  }
});

// Commit 1 — the pure wake primitives: envelope builders + classify policy.
// No wiring; these run entirely off plain objects.

const test = require('node:test');
const assert = require('node:assert');
const { classify, hostOf } = require('../lib/channel/policy');
const {
  wakeEnvelope, sanitizeSummary, sanitizeMeta, sanitizeMetaKey, META_KEYS,
} = require('../lib/channel/envelope');

// ── classify: captures ───────────────────────────────────────────────────────

test('classify: a capture event enqueues (never immediate)', () => {
  const r = classify({ kind: 'capture', capture_id: 'cap4', seq: 12, url: 'https://app.trimble.com/flow/7', profile: 'trimble-flow', source: 'ext:tab-stream' });
  assert.equal(r.action, 'enqueue');
  assert.equal(r.item.kind, 'capture');
  assert.equal(r.item.capture_id, 'cap4');
  assert.equal(r.item.source, 'ext:tab-stream');
  assert.equal(r.item.seq, 12);
  // trusted frame only: host + profile + id, never body
  assert.match(r.item.summary, /app\.trimble\.com/);
  assert.match(r.item.summary, /trimble-flow/);
  assert.match(r.item.summary, /cap4/);
});

// ── classify: source-gating (self-wake safety) ───────────────────────────────

test('classify: a server-sourced store write is never wake-worthy', () => {
  const decl = { signals: { form_submit: { wake: 'queue' } } };
  assert.equal(classify({ kind: 'store', patch: { form_submit: { seq: 1 } }, source: 'server' }, decl), null);
});

test('classify: a gesture-stamped write to a non-declared key coalesces as activity (opt-out routing)', () => {
  const decl = { signals: { form_submit: { wake: 'queue' } } };
  const r = classify({ kind: 'store', patch: { slider: 42 }, source: 'browser', mount: 'm1', gesture: true, seq: 7 }, decl);
  assert.equal(r.action, 'coalesce');
  assert.equal(r.item.kind, 'activity');
  assert.equal(r.item.origin_mount, 'm1');
  assert.equal(r.item.counts.store, 1);
  // key NAMES may ride the summary; the VALUE never does
  assert.match(r.item.summary, /slider/);
  assert.doesNotMatch(r.item.summary, /42/);
});

test('classify: an undeclared write WITHOUT a gesture stamp is script traffic, not activity', () => {
  // a pane script's init/tick writes must never enqueue a phantom item
  assert.equal(classify({ kind: 'store', patch: { counter: 0 }, source: 'browser', mount: 'm1' }, { signals: {} }), null);
});

test('classify: a pane that opted out of routing stays silent', () => {
  const ctx = { signals: {}, routing: { m1: 'none' } };
  assert.equal(classify({ kind: 'store', patch: { slider: 42 }, source: 'browser', mount: 'm1', gesture: true }, ctx), null);
  assert.equal(classify({ kind: 'dom', type: 'change', mountId: 'm1', tag: 'INPUT' }, ctx), null);
});

// ── classify: declared browser signals ───────────────────────────────────────

test('classify: a browser write to a declared queue signal enqueues', () => {
  const decl = { signals: { form_submit: { wake: 'queue', mount: 'm1' } } };
  const r = classify({ kind: 'store', patch: { form_submit: { seq: 3, payload: { secret: 'x' } } }, source: 'browser', seq: 20 }, decl);
  assert.equal(r.action, 'enqueue');
  assert.equal(r.item.kind, 'signal');
  assert.equal(r.item.signal_key, 'form_submit');
  assert.equal(r.item.origin_mount, 'm1');
  assert.equal(r.item.payload_seq, 3);
  // the payload body must NOT leak into the summary
  assert.doesNotMatch(r.item.summary, /secret/);
  assert.match(r.item.summary, /form_submit/);
});

test('classify: a declared immediate signal wakes directly, bypassing the queue', () => {
  const decl = { signals: { ask_claude: { wake: 'immediate', mount: 'panel' } } };
  const r = classify({ kind: 'store', patch: { ask_claude: { seq: 1 } }, source: 'browser' }, decl);
  assert.equal(r.action, 'wake');
  assert.equal(r.item.kind, 'signal');
  assert.equal(r.item.origin_mount, 'panel');
});

test('classify: an immediate signal wins over a queued one in the same patch', () => {
  const decl = { signals: { a: { wake: 'queue' }, b: { wake: 'immediate' } } };
  const r = classify({ kind: 'store', patch: { a: { seq: 1 }, b: { seq: 1 } }, source: 'browser' }, decl);
  assert.equal(r.action, 'wake');
  assert.equal(r.item.signal_key, 'b');
});

// ── classify: pinned comments ────────────────────────────────────────────────

test('classify: a newly-added shared pin enqueues as a comment', () => {
  const r = classify({ kind: 'comment', op: 'add', pin: { id: 'c3', seq: 7, shared: true, text: 'totals look off', anchor: { mount: 'm1' } } });
  assert.equal(r.action, 'enqueue');
  assert.equal(r.item.kind, 'element');
  assert.equal(r.item.type, 'comment');
  assert.equal(r.item.element_id, 'c3');
  assert.equal(r.item.respond, true);
  assert.equal(r.item.origin_mount, 'm1');
  assert.equal(r.item.seq, 7);
  assert.match(r.item.summary, /m1/);
  assert.match(r.item.summary, /totals look off/);
});

// F.3: a pin on a markdown item. Its anchor is a source record ({md}, no
// mount); its locator names the item and the section it is about.
test('classify: an md pin names its markdown item (origin_mount) and its section in the summary; a pane pin\'s item is unchanged', () => {
  const src = { v: 1, kind: 'source', md: 'md-3', slug: 'release-plan', quote: { exact: 'Release plan', prefix: '', suffix: '' }, pos: { start: 3, end: 15 } };
  const r = classify({ kind: 'comment', op: 'add', pin: { id: 'c20', seq: 4, shared: true, text: 'is this the right order?', anchor: src,
    locator: { mount: 'md-3', selector: 'h2', text: 'Release plan', ordinal: 0, section: 'Release plan' } } });
  assert.equal(r.action, 'enqueue');
  assert.equal(r.item.origin_mount, 'md-3', 'the md item');
  assert.equal(r.item.summary, 'md-3 · on section "Release plan" · "is this the right order?"');
  // No locator: the source record's md is the item, and no section is said.
  const bare = classify({ kind: 'comment', op: 'add', pin: { id: 'c21', seq: 5, shared: true, text: 'hm', anchor: src } });
  assert.equal(bare.item.origin_mount, 'md-3');
  assert.equal(bare.item.summary, 'md-3 · "hm"');
  // A pane pin: as before.
  const pane = classify({ kind: 'comment', op: 'add', pin: { id: 'c22', seq: 6, shared: true, text: 'totals look off', anchor: { mount: 'm1' } } });
  assert.equal(pane.item.origin_mount, 'm1');
  assert.equal(pane.item.summary, 'm1 · "totals look off"');
  const engine = classify({ kind: 'comment', op: 'add', pin: { id: 'c23', seq: 7, shared: true, text: 'x',
    anchor: { v: 1, kind: 'element', mount: 'm2' }, locator: { mount: 'm2', selector: 'p.lead', text: 'lead', ordinal: 0 } } });
  assert.equal(engine.item.origin_mount, 'm2');
  assert.equal(engine.item.summary, 'm2 · "x"');
  const none = classify({ kind: 'comment', op: 'add', pin: { id: 'c24', seq: 8, shared: true, text: '', anchor: null } });
  assert.equal(none.item.origin_mount, null);
  assert.equal(none.item.summary, 'comment');
});

// F.6 (U406; RULED Q8 (a)): a chained pin's summary names its chain after the
// item, smallest first; a member the event's chain_private lists reads 'a
// private element', with no type and no id. A chainless pin is unchanged.
test('commentItem / classify: a chained pin\'s summary names the chain smallest first; a hidden member reads "a private element"; a chainless pin\'s summary and event are unchanged', () => {
  const { commentItem } = require('../lib/channel/policy');
  const pin = { id: 'c9', seq: 9, shared: true, text: 'why this colour?', anchor: { mount: 'm1' }, chain: ['h7', 'g3', 'c2'] };
  assert.equal(commentItem(pin).summary, 'm1 · on highlight h7 › box grab g3 › comment c2 · "why this colour?"');
  const hidden = commentItem(pin, { hidden: ['g3'] });
  assert.equal(hidden.summary, 'm1 · on highlight h7 › a private element › comment c2 · "why this colour?"');
  assert.doesNotMatch(hidden.summary, /g3|box grab/, 'no type and no id for a private member');
  // classify hands the event's chain_private to commentItem, for every op that raises or refreshes.
  for (const ev of [
    { op: 'add' },
    { op: 'reply', author: 'user', pin: { ...pin, replies: [{ author: 'user', text: 'and?' }] } },
    { op: 'edit', became_shared: true },
    { op: 'edit' },
  ]) {
    const r = classify({ kind: 'comment', pin, ...ev, chain_private: ['h7'] });
    assert.match(r.item.summary, /^m1 · on a private element › box grab g3 › comment c2 · "/, ev.op);
    assert.doesNotMatch(r.item.summary, /h7/);
  }
  // An md pin: the item, the chain, then the pin's own section.
  const md = commentItem({ id: 'c10', seq: 10, shared: true, text: 'ok', anchor: { v: 1, kind: 'source', md: 'md-2' },
    locator: { mount: 'md-2', selector: 'p', text: 'x', ordinal: 0, section: 'Plan' }, chain: ['h4'] });
  assert.equal(md.summary, 'md-2 · on highlight h4 · on section "Plan" · "ok"');
  // Chainless: byte-unchanged, whether or not the event carries chain_private.
  const bare = { id: 'c3', seq: 7, shared: true, text: 'totals look off', anchor: { mount: 'm1' } };
  const a = classify({ kind: 'comment', op: 'add', pin: bare });
  const b = classify({ kind: 'comment', op: 'add', pin: bare, chain_private: [] });
  const c = classify({ kind: 'comment', op: 'add', pin: { ...bare, chain: [] } });
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(a.item.summary, 'm1 · "totals look off"');
});

test('classify: a private pin never enqueues', () => {
  assert.equal(classify({ kind: 'comment', op: 'add', pin: { id: 'c4', shared: false, text: 'secret', anchor: { mount: 'm1' } } }), null);
});

test('classify: a bare comment event (no pin) never classifies', () => {
  assert.equal(classify({ kind: 'comment' }), null);
  // a plain text edit of a shared pin now refreshes (F9) rather than classifying to
  // null — see the dedicated F9 test below.
});

test('classify: un-sharing (edit → private) or deleting a pin dequeues it from the wake rail', () => {
  // the reverse of the shared toggle/add — a pin that leaves Claude's view leaves the queue
  assert.deepEqual(classify({ kind: 'comment', op: 'edit', pin: { id: 'c5', shared: false } }), { action: 'dequeue', element_id: 'c5' });
  assert.deepEqual(classify({ kind: 'comment', op: 'delete', id: 'c9' }), { action: 'dequeue', element_id: 'c9' });
});

test('classify: an un-share dequeue keys on the writer-stamped became_private (B7)', () => {
  // Primary key is the explicit flag (symmetric with became_shared). Proven load-
  // bearing: even with pin.shared still truthy, became_private drives the dequeue —
  // it must NOT fall through to the shared-pin refresh/enqueue branches.
  assert.deepEqual(
    classify({ kind: 'comment', op: 'edit', became_private: true, pin: { id: 'c5', shared: true } }),
    { action: 'dequeue', element_id: 'c5' },
  );
  // cheap defensive fallback: a raw shared:false with no flag still dequeues.
  assert.deepEqual(
    classify({ kind: 'comment', op: 'edit', pin: { id: 'c7', shared: false } }),
    { action: 'dequeue', element_id: 'c7' },
  );
});

test('classify: a private→shared toggle (edit + became_shared) enqueues; a plain text edit stays quiet', () => {
  const pin = { id: 'c5', seq: 11, shared: true, text: 'now visible', anchor: { mount: 'm1' } };
  const r = classify({ kind: 'comment', op: 'edit', became_shared: true, pin });
  assert.equal(r.action, 'enqueue');
  assert.equal(r.item.kind, 'element');
  assert.equal(r.item.element_id, 'c5');
  assert.equal(r.item.seq, 11);
  assert.match(r.item.summary, /now visible/);
  // an edit that did NOT flip privacy carries no became_shared → not a fresh enqueue,
  // but a plain text edit of an already-shared pin refreshes the queued summary (F9)
  assert.equal(classify({ kind: 'comment', op: 'edit', pin }).action, 'refresh');
});

test('classify: a USER reply on a shared pin enqueues (continues the thread)', () => {
  const r = classify({ kind: 'comment', op: 'reply', author: 'user', pin: {
    id: 'c3', seq: 9, shared: true, text: 'root', anchor: { mount: 'm1' },
    replies: [{ author: 'user', text: 'and another thing', at: 1 }],
  } });
  assert.equal(r.action, 'enqueue');
  assert.equal(r.item.kind, 'element');
  assert.equal(r.item.seq, 9);
  assert.equal(r.item.why_wake, 'comment reply');
  assert.match(r.item.summary, /and another thing/); // summarizes the LATEST message, not the root
  // C6: the routing hint is NOT stamped per item — it rides the envelope wake-line
  // (by kind) and the get_comments top-level field instead.
  assert.ok(!('respond_hint' in r.item), 'no per-item respond_hint stamp');
});

test("classify: Claude's own reply never enqueues (self-wake gate for the write tool)", () => {
  assert.equal(classify({ kind: 'comment', op: 'reply', author: 'claude', pin: {
    id: 'c3', shared: true, text: 'root', replies: [{ author: 'claude', text: 'done', at: 1 }],
  } }), null);
});

test('classify: re-share after a Claude reply quotes the last USER message, never Claude (F8)', () => {
  // Claude answered, the user un-shared, then re-shared: the enqueue must hand off
  // the user's own words (here the root, since the user never replied), NOT Claude's.
  const r = classify({ kind: 'comment', op: 'edit', became_shared: true, pin: {
    id: 'c3', seq: 14, shared: true, text: 'the totals look off', anchor: { mount: 'm1' },
    replies: [{ author: 'claude', text: 'I recomputed them — look right now?', at: 2 }],
  } });
  assert.equal(r.action, 'enqueue');
  assert.match(r.item.summary, /the totals look off/, 'quotes the user root, not the trailing Claude reply');
  assert.doesNotMatch(r.item.summary, /recomputed/);
  assert.equal(r.item.why_wake, 'comment pinned for Claude', "why_wake reflects a root quote, not 'comment reply'");
});

test('classify: with a later USER reply after Claude, F8 quotes that user reply', () => {
  const r = classify({ kind: 'comment', op: 'reply', author: 'user', pin: {
    id: 'c3', seq: 15, shared: true, text: 'root', anchor: { mount: 'm1' },
    replies: [
      { author: 'user', text: 'first ask', at: 1 },
      { author: 'claude', text: 'my answer', at: 2 },
      { author: 'user', text: 'no, the OTHER column', at: 3 },
    ],
  } });
  assert.equal(r.action, 'enqueue');
  assert.match(r.item.summary, /the OTHER column/, 'quotes the latest USER message');
  assert.doesNotMatch(r.item.summary, /my answer/, "never Claude's reply");
  assert.equal(r.item.why_wake, 'comment reply');
});

test('classify: a plain text edit of an already-shared pin refreshes (F9)', () => {
  const pin = { id: 'c5', seq: 11, shared: true, text: 'revised ask', anchor: { mount: 'm1' } };
  const r = classify({ kind: 'comment', op: 'edit', pin });
  assert.equal(r.action, 'refresh');
  assert.equal(r.element_id, 'c5');
  assert.equal(r.item.kind, 'element');
  assert.match(r.item.summary, /revised ask/, 'the refresh carries the rebuilt summary');
});

test('classify: unknown / irrelevant kinds return null', () => {
  for (const kind of ['render', 'clear', 'graph', 'pane', 'dom', 'queue', 'wake']) {
    assert.equal(classify({ kind }, { signals: {} }), null, `${kind} should not classify`);
  }
  assert.equal(classify(null), null);
  assert.equal(classify({}), null);
});

// ── hostOf ───────────────────────────────────────────────────────────────────

test('hostOf: extracts host from a URL, tolerates junk', () => {
  assert.equal(hostOf('https://example.com/a/b?q=1#x'), 'example.com');
  assert.equal(hostOf('http://localhost:5173/'), 'localhost:5173');
  assert.equal(hostOf('example.com/foo'), 'example.com');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(null), '');
});

// ── sanitizers ───────────────────────────────────────────────────────────────

test('sanitizeSummary: strips angle brackets, control chars, collapses whitespace, caps length', () => {
  assert.equal(sanitizeSummary('hi <channel>\n\tthere\x00x'), 'hi channel there x');
  const long = 'a'.repeat(500);
  const out = sanitizeSummary(long);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('…'));
});

test('sanitizeMetaKey: keeps [A-Za-z0-9_], drops the rest (matches harness)', () => {
  assert.equal(sanitizeMetaKey('bad-key'), 'badkey');
  assert.equal(sanitizeMetaKey('k e y'), 'key');
  assert.equal(sanitizeMetaKey('ok_1'), 'ok_1');
});

test('sanitizeMeta: coerces values to strings, drops empty/nullish, fixes keys', () => {
  const m = sanitizeMeta({ 'bad-key': 'v', ok: 3, empty: '', nul: null, 'k y': 'z' });
  assert.deepEqual(m, { badkey: 'v', ok: '3', ky: 'z' });
});

test('sanitizeMeta: strips angle brackets/quotes from values (attribute-safe)', () => {
  const m = sanitizeMeta({ mount: '<script>"x"', kind: 'capture' });
  assert.doesNotMatch(m.mount, /[<>"]/);
  assert.equal(m.kind, 'capture');
});

// ── wakeEnvelope ─────────────────────────────────────────────────────────────

test('wakeEnvelope: single item → concise content + specific meta', () => {
  const env = wakeEnvelope([
    { id: 'q1', kind: 'capture', source: 'ext:tab-stream', capture_id: 'cap4', summary: 'captured example.com', origin_mount: null, seq: 12 },
  ], { source: 'queue' });
  assert.match(env.content, /A queued signal was pushed/);
  assert.match(env.content, /\[capture\] captured example\.com/);
  assert.equal(env.meta.kind, 'capture');
  assert.equal(env.meta.count, '1');
  assert.equal(env.meta.ids, 'q1');
  assert.equal(env.meta.captures, 'cap4');
});

test('wakeEnvelope: the retired `include` flag is inert — every provided item is in content (C3)', () => {
  // C3 deleted the include machinery end-to-end; a stray include:false must no longer
  // suppress an item (nothing ever sets it, and the envelope filter is gone).
  const env = wakeEnvelope([
    { id: 'q1', kind: 'capture', summary: 'shown', seq: 1 },
    { id: 'q2', kind: 'signal', summary: 'also shown', seq: 2, include: false },
  ]);
  assert.match(env.content, /shown/);
  assert.match(env.content, /also shown/);
  assert.equal(env.meta.count, '2');
  assert.equal(env.meta.ids, 'q1,q2');
});

test('wakeEnvelope: a large batch caps the summary lines (bounded injected context) but keeps the true count', () => {
  // A park merged over a session (or a capture flood) must not blast an arbitrarily
  // long per-item list into the injected prompt context. The lines are capped and
  // the omitted remainder disclosed; the header/meta still report the full count and
  // Claude fetches the omitted bodies via the ids meta.
  const batch = Array.from({ length: 300 }, (_, i) => ({ id: `q${i}`, kind: 'signal', summary: `sig ${i}`, seq: i }));
  const env = wakeEnvelope(batch, { source: 'queue' });
  const itemLines = env.content.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(itemLines.length < 60, `line count is bounded, not ~300 (${itemLines.length})`);
  assert.match(env.content, /300 queued signals were pushed/, 'the header still reports the true count');
  assert.match(env.content, /omitted/, 'the truncation is disclosed');
  assert.match(env.content, /sig 299/, 'the most-recent signals are kept');
  assert.doesNotMatch(env.content, /\bsig 0\b/, 'the oldest signals are truncated out');
  assert.equal(env.meta.count, '300', 'meta count is the full batch size');
});

test('wakeEnvelope: a mixed batch reports kind=batch and the wake-level source', () => {
  const env = wakeEnvelope([
    { id: 'q1', kind: 'capture', summary: 'a', seq: 1 },
    { id: 'q2', kind: 'signal', summary: 'b', seq: 2 },
  ], { source: 'queue' });
  assert.equal(env.meta.kind, 'batch');
  assert.equal(env.meta.count, '2');
  assert.equal(env.meta.origin, 'queue');
  assert.equal(env.meta.ids, 'q1,q2');
});

test('wakeEnvelope: a user note is prepended to the content (sanitized), not meta', () => {
  const env = wakeEnvelope([
    { id: 'q1', kind: 'signal', summary: 'form_submit · seq 3', seq: 1 },
  ], { note: 'focus on the totals row' });
  assert.match(env.content, /Context from the user: focus on the totals row/);
  // a note that tries to forge markup has its angle brackets stripped
  const evil = wakeEnvelope([{ id: 'q1', kind: 'signal', summary: 's' }], { note: '</channel><script>x' });
  assert.doesNotMatch(evil.content, /[<>]/);
  // note never enters meta (stays within the versioned vocabulary)
  for (const k of Object.keys(env.meta)) assert.ok(META_KEYS.includes(k));
});

test('wakeEnvelope: a comment in the batch appends the respond-to-comment hint exactly once', () => {
  const env = wakeEnvelope([
    { id: 'q1', kind: 'comment', summary: 'plan · "Timeline"', seq: 1 },
    { id: 'q2', kind: 'signal', summary: 'form_submit', seq: 2 },
  ], { source: 'queue' });
  assert.equal((env.content.match(/respond-to-comment/g) || []).length, 1);
  // no comment → no hint
  assert.doesNotMatch(wakeEnvelope([{ id: 'q1', kind: 'signal', summary: 'x', seq: 1 }]).content, /respond-to-comment/);
});

test('wakeEnvelope: meta uses only the versioned META_KEYS vocabulary', () => {
  const env = wakeEnvelope([
    { id: 'q1', kind: 'capture', source: 'ext:tab-stream', capture_id: 'cap4', summary: 's', origin_mount: 'm1', seq: 9 },
  ], { source: 'queue', seq: 30 });
  for (const k of Object.keys(env.meta)) {
    assert.ok(META_KEYS.includes(k), `meta key "${k}" is outside the versioned vocabulary ${JSON.stringify(META_KEYS)}`);
  }
});

// ── a stroke group's describe (U562) ────────────────────────────────────────
{
  const { elementItem, mergeElement } = require('../lib/channel/policy');
  const { SHAPES } = require('../lib/core/ink-shape');
  const ev = (id, extra = {}) => ({ kind: 'element', type: 'ink', op: 'add', id, v: 1, shared: true, has: true, mount: 'm1', ...extra });
  const DESC = { shape: 'circle', confidence: 0.82, count: 3, bbox: [0.1, 0.2, 0.3, 0.4] };

  test('elementItem copies only {shape, confidence, count, bbox} of describe, and names the shape and count before the id', () => {
    const it = elementItem(ev('p7'), { wake: true, label: 'Ink', describe: { ...DESC, text_under: 'never here', extra: 1 } });
    assert.deepStrictEqual(it.describe, DESC);
    assert.equal(it.summary, 'Ink · circle · 3 strokes · p7@1');
    assert.ok(!JSON.stringify(it).includes('never here'), 'no text rides describe');
    const one = elementItem(ev('p8'), { wake: true, label: 'Ink', text: 'a note', describe: { ...DESC, count: 1 } });
    assert.equal(one.summary, 'Ink · circle · 1 stroke · p8@1 · "a note"');
    // No describe: the item is as it was.
    const plain = elementItem(ev('p9'), { wake: true, label: 'Ink' });
    assert.equal('describe' in plain, false);
    assert.equal(plain.summary, 'Ink · p9@1');
    for (const s of SHAPES) assert.equal(elementItem(ev('p1'), { wake: true, describe: { ...DESC, shape: s } }).describe.shape, s);
  });

  test('elementItem drops a describe whose shape is not a SHAPES word, or whose numbers are not numbers', () => {
    const bad = [
      { ...DESC, shape: 'Revenue fell' }, { ...DESC, shape: 'CIRCLE' }, { ...DESC, shape: 3 },
      { ...DESC, bbox: ['0.1', 0.2, 0.3, 0.4] }, { ...DESC, bbox: [0.1, 0.2, 0.3] }, { ...DESC, bbox: 'secret' },
      { ...DESC, confidence: '0.9' }, { ...DESC, confidence: 2 }, { ...DESC, count: 0 }, { ...DESC, count: 1.5 },
      'circle', null,
    ];
    for (const describe of bad) {
      const it = elementItem(ev('p3'), { wake: true, label: 'Ink', describe });
      assert.equal('describe' in it, false, JSON.stringify(describe));
      assert.equal(it.summary, 'Ink · p3@1', JSON.stringify(describe));
    }
  });

  test('mergeElement: the newest member\'s describe is the group\'s, dropped when the newest has none', () => {
    const a = elementItem(ev('p1'), { wake: true, label: 'Ink', describe: { ...DESC, count: 1 } });
    const group = mergeElement({ ...a, element_ids: [], excerpt: undefined }, a);
    assert.deepStrictEqual(group.describe, { ...DESC, count: 1 });
    // The daemon names the group a describe is of (U562a: its shared member ids).
    const b = elementItem(ev('p2'), { wake: true, label: 'Ink', describe: { ...DESC, shape: 'underline', count: 2, element_ids: ['p1', 'p2'] } });
    mergeElement(group, b);
    assert.deepStrictEqual(group.describe, { ...DESC, shape: 'underline', count: 2 }, 'the newest wins');
    assert.deepStrictEqual(group.element_ids, ['p1', 'p2']);
    const c = elementItem(ev('p3'), { wake: true, label: 'Ink' });
    mergeElement(group, c);
    assert.equal('describe' in group, false, 'the newest has none');
    assert.equal(group.count, 3);
  });
}

// ── a folded item keeps every group's describe (U562a, PQ-4F-3) ─────────────
{
  const { elementItem, mergeElement, DESCRIBE_GROUPS_MAX } = require('../lib/channel/policy');
  const ev = (id) => ({ kind: 'element', type: 'ink', op: 'add', id, v: 1, shared: true, has: true, mount: 'm1' });
  const raise = (id, describe) => elementItem(ev(id), { wake: true, label: 'Ink', describe });
  const start = (a) => mergeElement({ ...a, element_ids: [], excerpt: undefined }, a);
  const CIRCLE = { shape: 'circle', confidence: 0.82, count: 1, bbox: [0.1, 0.1, 0.2, 0.2] };
  const LINE = { shape: 'underline', confidence: 0.9, count: 1, bbox: [0.5, 0.6, 0.3, 0.05] };

  test('two groups folded: groups of 2 in fold order, count summed, bbox the union, the top-level shape the newest\'s', () => {
    const group = start(raise('p1', CIRCLE));
    mergeElement(group, raise('p2', LINE));
    assert.deepStrictEqual(group.describe, {
      shape: 'underline', confidence: 0.9, count: 2, bbox: [0.1, 0.1, 0.7, 0.55],
      groups: [{ ...CIRCLE, element_ids: ['p1'] }, { ...LINE, element_ids: ['p2'] }],
    });
    // The summary is the newest raise's, as before.
    assert.equal(group.summary, 'Ink · underline · 1 stroke · p2@1');
  });

  test('a group growing a stroke at a time stays one entry; six groups of seven strokes give six guesses', () => {
    const shapes = ['circle', 'underline', 'strike', 'arrow', 'check'];
    const group = start(raise('p11', { ...CIRCLE, bbox: [0.0, 0.0, 0.05, 0.05] }));
    shapes.slice(1).forEach((shape, i) => mergeElement(group, raise(`p1${i + 2}`, { shape, confidence: 0.7, count: 1, bbox: [0.1 * (i + 1), 0.1, 0.05, 0.05] })));
    // The cross: its first stroke, then the second (the group so far: count 2, the daemon naming both members).
    mergeElement(group, raise('p16', { shape: 'strike', confidence: 0.6, count: 1, bbox: [0.6, 0.3, 0.1, 0.06], element_ids: ['p16'] }));
    mergeElement(group, raise('p17', { shape: 'cross', confidence: 0.79, count: 2, bbox: [0.6, 0.3, 0.1, 0.06], element_ids: ['p16', 'p17'] }));
    const d = group.describe;
    assert.deepStrictEqual(d.groups.map((g) => g.shape), [...shapes, 'cross']);
    assert.deepStrictEqual(d.groups[5].element_ids, ['p16', 'p17']);
    assert.equal(d.count, 7, 'every stroke once');
    assert.equal(d.shape, 'cross');
    assert.equal(d.confidence, 0.79);
    assert.equal('groups_dropped' in d, false);
  });

  test('a single group\'s item is byte-equal to the U562 describe', () => {
    const a = raise('p1', CIRCLE);
    const group = start(a);
    assert.equal(JSON.stringify(group.describe), JSON.stringify(CIRCLE));
    const grown = { ...CIRCLE, shape: 'check', count: 2, bbox: [0.1, 0.1, 0.25, 0.2] };
    // The daemon's raise names the group (its ids); the delivered one-group describe is the four fields alone.
    mergeElement(group, raise('p2', { ...grown, element_ids: ['p1', 'p2'] }));
    assert.equal(JSON.stringify(group.describe), JSON.stringify(grown));
    // A member re-raised (a Send of one already queued) replaces its own group's entry.
    mergeElement(group, raise('p1', { ...grown, element_ids: ['p1', 'p2'] }));
    assert.equal(JSON.stringify(group.describe), JSON.stringify(grown));
    // A kept one-group item re-sent folds as itself.
    const again = start({ ...group, element_ids: ['p1', 'p2'] });
    assert.equal(JSON.stringify(again.describe), JSON.stringify(grown));
  });

  test('the group identity is its ids, never a box: interleaved groups on two targets keep each guess', () => {
    // A1 on svg1, B1 on svg2, then A2 (A's second stroke): each box is in its own target's frame.
    const group = start(raise('p1', { shape: 'strike', confidence: 0.6, count: 1, bbox: [0.1, 0.1, 0.2, 0.2], element_ids: ['p1'] }));
    mergeElement(group, raise('p2', { shape: 'circle', confidence: 0.8, count: 1, bbox: [0.3, 0.3, 0.1, 0.1], element_ids: ['p2'] }));
    mergeElement(group, raise('p3', { shape: 'cross', confidence: 0.79, count: 2, bbox: [0.1, 0.1, 0.4, 0.4], element_ids: ['p1', 'p3'] }));
    const d = group.describe;
    assert.deepStrictEqual(d.groups.map((g) => [g.shape, g.element_ids]), [['circle', ['p2']], ['cross', ['p1', 'p3']]]);
    assert.equal(d.count, 3);
    assert.equal(d.shape, 'cross');
    // A count-2 raise whose box holds an older listed group's swallows nothing.
    const g2 = start(raise('p4', { ...CIRCLE, bbox: [0.2, 0.2, 0.1, 0.1], element_ids: ['p4'] }));
    mergeElement(g2, raise('p5', { ...LINE, element_ids: ['p5'] }));
    mergeElement(g2, raise('p7', { shape: 'other', confidence: 0.5, count: 2, bbox: [0, 0, 1, 1], element_ids: ['p6', 'p7'] }));
    assert.deepStrictEqual(g2.describe.groups.map((g) => g.shape), ['circle', 'underline', 'other']);
    assert.equal(g2.describe.count, 4);
    // A malformed group id list drops the describe, as any malformed field does.
    assert.equal('describe' in raise('p8', { ...LINE, element_ids: [] }), false);
    assert.equal('describe' in raise('p8', { ...LINE, element_ids: ['p8', 3] }), false);
  });

  test('a raise whose group joins two listed groups folds them into one entry (a private stroke between them shared later)', () => {
    // A [p1] and B [p3] were two groups while p2 sat private between them; once p2 is shared the daemon's
    // group is [p1, p2, p3], so both entries go and one takes their place: every stroke counted once.
    const group = start(raise('p1', { ...CIRCLE, element_ids: ['p1'] }));
    mergeElement(group, raise('p3', { ...LINE, element_ids: ['p3'] }));
    assert.equal(group.describe.groups.length, 2);
    const joined = { shape: 'other', confidence: 0.5, count: 3, bbox: [0.1, 0.1, 0.7, 0.55] };
    mergeElement(group, raise('p2', { ...joined, element_ids: ['p1', 'p2', 'p3'] }));
    assert.equal(JSON.stringify(group.describe), JSON.stringify(joined), 'one group left: its describe alone');
  });

  test('a malformed groups entry or groups_dropped drops the describe', () => {
    const good = { ...LINE, element_ids: ['p1'] };
    const bad = [
      { groups: 'x' }, { groups: [] }, { groups: [{ ...good, shape: 'Revenue' }] }, { groups: [{ ...good, element_ids: [] }] },
      { groups: [{ ...good, element_ids: [3] }] }, { groups: [{ ...good, count: 0 }] }, { groups: [{ ...good, bbox: [0, 0, 1] }] },
      { groups: Array.from({ length: DESCRIBE_GROUPS_MAX + 1 }, () => good) },
      { groups: [good], groups_dropped: 0 }, { groups: [good], groups_dropped: 1.5 }, { groups_dropped: 1 },
    ];
    for (const extra of bad) {
      const it = raise('p3', { ...LINE, ...extra });
      assert.equal('describe' in it, false, JSON.stringify(extra));
      assert.equal(it.summary, 'Ink · p3@1', JSON.stringify(extra));
    }
    // The well-formed list passes whole.
    assert.deepStrictEqual(raise('p3', { ...LINE, groups: [good], groups_dropped: 2 }).describe, { ...LINE, groups: [good], groups_dropped: 2 });
  });

  test('the 17th group drops the oldest, counted in groups_dropped; an undescribed raise leaves the list as it is', () => {
    const box = (i) => [0.05 * i, 0, 0.01, 0.01];
    const group = start(raise('p0', { ...CIRCLE, bbox: box(0) }));
    for (let i = 1; i < DESCRIBE_GROUPS_MAX; i++) mergeElement(group, raise(`p${i}`, { ...CIRCLE, bbox: box(i) }));
    assert.equal(group.describe.groups.length, DESCRIBE_GROUPS_MAX);
    assert.equal('groups_dropped' in group.describe, false);
    mergeElement(group, raise('p16', { ...LINE, bbox: box(16) }));
    const d = group.describe;
    assert.equal(d.groups.length, DESCRIBE_GROUPS_MAX);
    assert.equal(d.groups_dropped, 1);
    assert.deepStrictEqual(d.groups[0].element_ids, ['p1'], 'the oldest went');
    assert.equal(d.count, DESCRIBE_GROUPS_MAX);
    assert.deepStrictEqual(d.bbox, [0.05, 0, 0.76, 0.01]);
    const before = JSON.stringify(group.describe);
    mergeElement(group, raise('p17'));
    assert.equal(JSON.stringify(group.describe), before, 'no entry added, the list unchanged');
    // A kept item re-sent (resendElement → a fresh fold) keeps its dropped count.
    const resent = start({ ...group, element_ids: [...group.element_ids], describe: d });
    assert.equal(resent.describe.groups_dropped, 1, 'the re-sent fold still says one group went');
    assert.equal(resent.describe.groups.length, DESCRIBE_GROUPS_MAX);
  });
}

// ── replaceDescribe: an edit or a leaver changes only its group's entry (U633, 5B.3; K.2-251) ──
{
  const { replaceDescribe, elementItem, mergeElement, DESCRIBE_GROUPS_MAX } = require('../lib/channel/policy');
  const A = { shape: 'circle', confidence: 0.8, count: 2, bbox: [0.1, 0.1, 0.2, 0.2], element_ids: ['a1', 'a2'] };
  const B = { shape: 'underline', confidence: 0.9, count: 1, bbox: [0.5, 0.6, 0.3, 0.05], element_ids: ['b1'] };
  const C = { shape: 'strike', confidence: 0.6, count: 1, bbox: [0.0, 0.9, 0.1, 0.05], element_ids: ['c1'] };
  const folded = (...groups) => {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const { bbox: b } of groups) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]); }
    const r = (v) => Math.round(v * 1e4) / 1e4;
    const top = groups[groups.length - 1];
    return { shape: top.shape, confidence: top.confidence, count: groups.reduce((n, g) => n + g.count, 0), bbox: [r(x0), r(y0), r(x1 - x0), r(y1 - y0)], groups };
  };
  const members = ['a1', 'a2', 'b1', 'c1'];

  test('replaceDescribe over a two-group fold: the entry the ids meet is replaced in place, order kept, the top level re-derived', () => {
    const prior = folded(A, B);
    const frozen = JSON.stringify(prior);
    const edited = { shape: 'check', confidence: 0.7, count: 2, bbox: [0.2, 0.0, 0.1, 0.3], element_ids: ['a1', 'a2'] };
    const out = replaceDescribe(prior, members, edited, ['a1', 'a2']);
    assert.deepStrictEqual(out.groups, [edited, B], 'the older entry refreshed where it was; the newer untouched');
    assert.equal(out.count, 3);
    assert.deepStrictEqual(out.bbox, [0.2, 0, 0.6, 0.65], 'the union of the entries');
    assert.equal(out.shape, 'underline', 'the last entry\'s shape on top');
    assert.equal(out.confidence, 0.9);
    assert.equal(JSON.stringify(prior), frozen, 'the prior is never edited (F7)');
    // The newest's own edit replaces only its entry; groups kept.
    const nb = replaceDescribe(prior, members, { ...B, shape: 'strike', bbox: [0.5, 0.6, 0.3, 0.1] }, ['b1']);
    assert.deepStrictEqual(nb.groups.map((g) => [g.shape, g.element_ids]), [['circle', ['a1', 'a2']], ['strike', ['b1']]]);
    assert.equal(nb.shape, 'strike');
    // A refresh naming no ids of its own takes the ids it was handed.
    const bare = { shape: 'other', confidence: 0.5, count: 1, bbox: [0.5, 0.6, 0.3, 0.05] };
    assert.deepStrictEqual(replaceDescribe(prior, members, bare, ['b1']).groups[1], { ...bare, element_ids: ['b1'] });
  });

  test('replaceDescribe drops one entry of three (next null), and a drop leaving one gives the four fields alone', () => {
    const prior = folded(A, B, C);
    const two = replaceDescribe(prior, members, null, ['b1']);
    assert.deepStrictEqual(two, folded(A, C), 'B\'s entry gone, A and C kept in order, the top level re-derived');
    const one = replaceDescribe(two, members, null, ['a2']);
    assert.deepStrictEqual(one, { shape: C.shape, confidence: C.confidence, count: C.count, bbox: C.bbox });
    assert.equal('element_ids' in one, false);
    assert.equal('groups' in one, false);
    assert.equal(replaceDescribe(one, ['c1'], null, ['c1']), null, 'none left → null');
    // A one-group describe names no ids: its ids are the members it was handed.
    assert.equal(replaceDescribe({ ...C, element_ids: undefined }, ['c1', 'c2'], null, ['c2']), null);
    // Every entry the ids meet goes (a re-send's several gone members).
    assert.deepStrictEqual(replaceDescribe(prior, members, null, ['a1', 'c1']), { shape: B.shape, confidence: B.confidence, count: B.count, bbox: B.bbox });
  });

  test('replaceDescribe keeps groups_dropped (no four-field collapse while one went), and returns the prior itself when no entry meets the ids', () => {
    const prior = { ...folded(A, B), groups_dropped: 2 };
    const out = replaceDescribe(prior, members, null, ['a1']);
    assert.equal(out.groups_dropped, 2);
    assert.deepStrictEqual(out.groups, [B], 'one entry, but older groups went: still a list');
    const edited = replaceDescribe(prior, members, { ...A, count: 3 }, ['a2']);
    assert.equal(edited.groups_dropped, 2);
    assert.equal(edited.count, 4);
    assert.equal(replaceDescribe(prior, members, null, ['zz']), prior, 'a drop meeting nothing: unchanged');
    assert.equal(replaceDescribe(prior, members, { ...C, element_ids: ['zz'] }, ['zz']), prior, 'a replace meeting nothing: unchanged');
    assert.equal(replaceDescribe(null, members, A, ['a1']), null);
    assert.equal(replaceDescribe(undefined, members, null, ['a1']), null);
  });

  test('replaceDescribe carries the incoming entry\'s checked fields whole (a page group\'s frame and items) and never a field the check drops', () => {
    const arrow = { shape: 'arrow', confidence: 0.7, count: 1, bbox: [0.3, 0.3, 0.2, 0.1], element_ids: ['b1'], frame: 'page', items: ['pa', 'pb'] };
    const prior = folded({ ...A, frame: 'pane' }, arrow);
    const moved = { ...arrow, bbox: [0.3, 0.4, 0.2, 0.1], items: ['pa', 'pc'], text_under: 'never here' };
    const out = replaceDescribe(prior, members, moved, ['b1']);
    assert.deepStrictEqual(out.groups[1], { shape: 'arrow', confidence: 0.7, count: 1, bbox: [0.3, 0.4, 0.2, 0.1], element_ids: ['b1'], frame: 'page', items: ['pa', 'pc'] });
    assert.deepStrictEqual(out.groups[0], { ...A, frame: 'pane' });
    assert.ok(!JSON.stringify(out).includes('never here'), 'no text rides describe');
    assert.equal('frame' in out, false, 'a multi-group describe names frames per group only');
    // One left: the four fields and its frame and items (the one-group fold's shape).
    assert.deepStrictEqual(replaceDescribe(out, members, null, ['a1']), { shape: 'arrow', confidence: 0.7, count: 1, bbox: [0.3, 0.4, 0.2, 0.1], frame: 'page', items: ['pa', 'pc'] });
    // A malformed incoming is no describe: the entry is dropped.
    assert.deepStrictEqual(replaceDescribe(prior, members, { ...arrow, shape: 'Revenue fell' }, ['b1']), { shape: 'circle', confidence: 0.8, count: 2, bbox: [0.1, 0.1, 0.2, 0.2], frame: 'pane' });
  });

  test('replaceDescribe over a mergeElement fold reads as the fold of the edited raise; at the cap it keeps the length and the dropped count', () => {
    const ev = (id) => ({ kind: 'element', type: 'ink', op: 'add', id, v: 1, shared: true, has: true, mount: 'm1' });
    const raise = (id, describe) => elementItem(ev(id), { wake: true, label: 'Ink', describe });
    // A group of one held member (a2): a one-group describe's ids are the item's members.
    const g = mergeElement({ ...raise('a2', A), element_ids: [], excerpt: undefined }, raise('a2', A));
    mergeElement(g, raise('b1', B));
    assert.deepStrictEqual(g.describe, folded({ ...A, element_ids: ['a2'] }, B));
    let d = g.describe;
    const A2 = { ...A, shape: 'cross', bbox: [0.1, 0.1, 0.25, 0.25], element_ids: ['a2'] };
    d = replaceDescribe(d, g.element_ids, A2, A2.element_ids);
    assert.deepStrictEqual(d, folded(A2, B));
    // At the cap a replace keeps the list's length and its dropped count.
    const many = Array.from({ length: DESCRIBE_GROUPS_MAX }, (_, i) => ({ ...C, bbox: [0.01 * i, 0.9, 0.01, 0.01], element_ids: [`k${i}`] }));
    const capped = { ...folded(...many), groups_dropped: 1 };
    const r = replaceDescribe(capped, [], { ...C, shape: 'check', element_ids: ['k3'] }, ['k3']);
    assert.equal(r.groups.length, DESCRIBE_GROUPS_MAX);
    assert.equal(r.groups[3].shape, 'check');
    assert.equal(r.groups_dropped, 1);
  });

  test('replaceDescribe: an edit whose group takes another entry\'s member strips it there (an emptied entry goes; no member in two entries)', () => {
    const prior = folded(A, B);
    const joined = { shape: 'circle', confidence: 0.7, count: 3, bbox: [0.1, 0.1, 0.7, 0.55], element_ids: ['a1', 'a2', 'b1'] };
    assert.deepStrictEqual(replaceDescribe(prior, members, joined, joined.element_ids),
      { shape: 'circle', confidence: 0.7, count: 3, bbox: [0.1, 0.1, 0.7, 0.55] }, 'the newest entry met (B) replaced, the older one (A) emptied and gone: the four fields alone');
    // The newest entry the ids meet is the one replaced; an older one they meet loses them.
    const three = folded({ ...A, count: 3, element_ids: ['a1', 'a2', 'a3'] }, B, C);
    const moved = { shape: 'underline', confidence: 0.6, count: 2, bbox: [0.3, 0.6, 0.5, 0.05], element_ids: ['a3', 'b1'] };
    const out = replaceDescribe(three, members, moved, moved.element_ids);
    assert.deepStrictEqual(out.groups.map((g) => g.element_ids), [['a1', 'a2'], ['a3', 'b1'], ['c1']], 'a3 left A; order kept');
  });
}

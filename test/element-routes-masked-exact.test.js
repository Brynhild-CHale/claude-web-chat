// A learned value's fragment inside a pin's own words (U415c; DECISIONS L.9,
// K.2-180, K.2-181; form 7 X3 = a, Y3 = a). U415a and U415b mask a value the
// redactor learns after a pin's write in the pin's context (its quote's prefix
// and suffix); this unit takes the pinned words themselves (`exact`), the
// 0.8.5 legacy locator's `text` and the event ring's pin through the same read
// view:
//   - a range pin whose exact opens on a learned value's tail (fewer than 8 of
//     its characters in the prefix), and one whose whole window lies inside a
//     long learned value: GET /api/elements and the element:comment frame
//     serve no fragment of it (findLeaks), and the pin reads masked (state,
//     visible, explain — anchor-states' 'masked' row);
//   - a pin with no learned value is served byte-equal;
//   - a comment posted with a legacy locator (alone, or beside an engine
//     record) whose text holds the value: GET /api/elements, the frame and GET
//     /api/graph/node/:id after a commit hold no fragment;
//   - the ring's comment entries: GET /api/events and the SSE stream serve
//     the pin masked, the ring's stored entry unchanged.
// The log bytes and the node file are never rewritten. Red at the W7 head
// (1469ebef) on each, the clean-pin test excepted.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const { findLeaks } = require('../test-support/fake-secrets');
const { projectPaths } = require('../lib/core/paths');
const { marksIn } = require('../lib/core/redact');
const { EXPLAIN } = require('../lib/core/anchor-states');

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const nodeFile = (root, id) => path.join(projectPaths(root).graphDir, `${id}.json`);
const near = (hay, leaks) => leaks.map((l) => hay.slice(Math.max(0, l.at - 80), l.at + 40)).join(' | ');
const noLeaks = (body, LEARNED, what) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const leaks = findLeaks(raw, LEARNED);
  assert.deepEqual(leaks, [], `${what} holds no fragment of the value: ${near(raw, leaks)}`);
};
// The ring's entries that carry a pin (this unit's): a `queue` entry's item
// (its summary quotes the pin's text as queued) is the queue's, not the pin's.
const pinEntries = (events) => (events || []).filter((e) => e && (e.kind === 'comment' || e.kind === 'element'));
const learned = (value) => [{ id: 'learned', rule: 'known', secrets: [value] }];

// A range anchor cut out of `text` as the chrome cuts one (32 characters of
// context each side).
function rangeIn(mount, text, exact, at = text.indexOf(exact)) {
  const quote = { exact, prefix: text.slice(Math.max(0, at - 32), at), suffix: text.slice(at + exact.length, at + exact.length + 32) };
  return { v: 1, kind: 'range', mount, quote, pos: { start: at, end: at + exact.length } };
}

// The redactor learns `value` through the capture token's file (a known
// source); `probe` is a pin whose text names it whole, masked once it is known.
async function learn(d, value, probeId) {
  fs.writeFileSync(projectPaths(d.root).captureToken, value + '\n');
  await waitUntil(async () => {
    const b = (await d.anonApi.get('/api/elements')).json;
    const p = ((b && b.elements) || []).find((e) => e.id === probeId);
    return p && typeof p.text === 'string' && !p.text.includes(value);
  }, { timeout: 6000, what: 'the redactor learned the value' });
}

// A local socket's frames, collected.
async function frames(t, d) {
  const got = [];
  const sock = d.ws();
  sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  await waitUntil(() => got.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
  return got;
}

function assertMasked(rec, what) {
  assert.ok(rec, `${what}: served`);
  assert.equal(rec.state, 'masked', `${what}: the pin reads masked`);
  assert.equal(rec.visible, 'masked', `${what}: visible`);
  assert.equal(rec.explain, EXPLAIN.masked, `${what}: the masked line`);
  const exact = rec.anchor && rec.anchor.quote && rec.anchor.quote.exact;
  assert.ok(typeof exact === 'string' && marksIn(exact).length >= 1, `${what}: the pinned words are served masked: ${JSON.stringify(exact)}`);
}

// The two shapes (the brief's twin): a value whose tail crosses into exact
// with fewer than 8 of its characters in the prefix, and a window cut out of
// the middle of a value longer than it.
async function twin(t) {
  const d = await withServer(t);
  const { api, anonApi } = d;
  const value = `wcexact${crypto.randomBytes(12).toString('hex')}`;
  const long = `wclong${crypto.randomBytes(48).toString('hex')}`;
  const text = `Use ${value} for access to the staging host now. Key ${long} ends here.`;
  await ok(api.post('/api/render', { id: 'm-exact', html: '<p>Use the token for access to the staging host now.</p>' }), 'render');
  // Four of the value's characters in the prefix, the rest of it in exact.
  const tailAt = text.indexOf(value) + 4;
  const tail = rangeIn('m-exact', text, `${value.slice(4)} for access`, tailAt);
  assert.ok(findLeaks(tail.quote.prefix, learned(value)).length === 0 && findLeaks(tail.quote.exact, learned(value)).length, 'precondition: the prefix holds under 8 of the value\'s characters, exact the rest');
  // A window wholly inside the long value: its prefix, exact and suffix.
  const insideAt = text.indexOf(long) + 40;
  const inside = rangeIn('m-exact', text, long.slice(40, 52), insideAt);
  assert.ok(long.includes(inside.quote.prefix + inside.quote.exact + inside.quote.suffix) && inside.quote.prefix.length === 32 && inside.quote.suffix.length === 32, 'precondition: the window lies wholly inside the long value');
  const h1 = (await ok(anonApi.post('/api/elements', { type: 'highlight', anchor: tail, payload: { note: 'tail' } }), 'highlight tail')).element;
  const c1 = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: tail, payload: { text: 'tail', shared: true } }), 'comment tail')).element;
  const h2 = (await ok(anonApi.post('/api/elements', { type: 'highlight', anchor: inside, payload: { note: 'inside' } }), 'highlight inside')).element;
  const c2 = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: inside, payload: { text: 'inside', shared: true } }), 'comment inside')).element;
  // The probes: pins whose text names each value whole.
  const p1 = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: tail, payload: { text: `names ${value}`, shared: true } }), 'probe')).element;
  const p2 = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: inside, payload: { text: `names ${long}`, shared: true } }), 'probe long')).element;
  return { ...d, value, long, tail, inside, ids: { h1: h1.id, c1: c1.id, h2: h2.id, c2: c2.id }, p1: p1.id, p2: p2.id };
}

test('a pin whose window lies wholly inside a long learned value: GET serves no fragment of it, the pin reads masked, the log bytes unchanged', async (t) => {
  const w = await twin(t);
  const before = logBytes(w.root);
  assert.ok(before.includes(w.tail.quote.exact) && before.includes(w.inside.quote.exact), 'precondition: stored as written');
  await learn(w, w.long, w.p2);
  const body = (await w.anonApi.get('/api/elements')).json;
  const els = new Map(body.elements.map((e) => [e.id, e]));
  noLeaks(els.get(w.ids.h2), learned(w.long), 'the inside highlight');
  noLeaks(els.get(w.ids.c2), learned(w.long), 'the inside comment');
  for (const k of ['h2', 'c2']) {
    const e = els.get(w.ids[k]);
    assertMasked(e, `${k} (inside)`);
    assert.equal(e.anchor.quote.prefix, '', `${k}: a prefix inside the value is dropped`);
    assert.equal(e.anchor.quote.suffix, '', `${k}: a suffix inside the value is dropped`);
    assert.equal(marksIn(e.anchor.quote.exact).length, 1, `${k}: exact is one mask`);
    assert.equal(e.anchor.quote.exact.length, marksIn(e.anchor.quote.exact)[0].end, `${k}: exact is the mask alone`);
    // The comment's engine record is served through the same view.
    if (e.record) noLeaks(e.record, learned(w.long), `${k}'s record`);
  }
  assert.equal(logBytes(w.root), before, 'the log bytes are unchanged');
});

test('a pin whose exact opens on a learned value\'s tail, under 8 of its characters in the prefix: GET serves exact masked from its head, the words after the value kept, and the pin reads masked', async (t) => {
  const w = await twin(t);
  await learn(w, w.value, w.p1);
  const body = (await w.anonApi.get('/api/elements')).json;
  const els = new Map(body.elements.map((e) => [e.id, e]));
  for (const k of ['h1', 'c1']) {
    const e = els.get(w.ids[k]);
    noLeaks(e, learned(w.value), `the tail ${k}`);
    assertMasked(e, `${k} (tail)`);
    const q = e.anchor.quote;
    const m = marksIn(q.exact);
    assert.ok(m.length === 1 && m[0].start === 0 && q.exact.slice(m[0].end) === ' for access', `${k}: exact is the mask then the words after the value: ${JSON.stringify(q.exact)}`);
    assert.equal(q.suffix, w.tail.quote.suffix, `${k}: a clean suffix is served as stored`);
    assert.ok(q.prefix.startsWith('Use '), `${k}: the prefix keeps the words before the value: ${JSON.stringify(q.prefix)}`);
    if (e.record) noLeaks(e.record, learned(w.value), `${k}'s record`);
  }
});

test('the element:comment frame after the value is learned holds no fragment of the pinned words, and its pins read masked; the live pins unchanged', async (t) => {
  const w = await twin(t);
  await learn(w, w.value, w.p1);
  const got = await frames(t, w);
  await ok(w.anonApi.post(`/api/elements/${w.ids.c1}/reply`, { text: 'a reply' }), 'reply');
  const frame = await waitUntil(() => got.filter((f) => f.type === 'element:comment').pop(), { timeout: 5000, what: 'the comment frame' });
  noLeaks(frame, learned(w.value), 'the comment frame');
  const pin = (frame.elements || []).find((p) => p && p.id === w.ids.c1);
  assertMasked(pin, 'the frame\'s pin');
  const held = w.srv.state.comments.find((p) => p.id === w.ids.c1);
  assert.deepEqual(held.anchor.quote, w.tail.quote, 'the live pin itself is unchanged');
  assert.ok(!('state' in held), 'the live pin carries no served state');
});

test('a pin with no learned value is served byte-equal, before and after a value is learned elsewhere', async (t) => {
  const d = await withServer(t);
  const { api, anonApi } = d;
  const text = 'Configuration information about the staging host is kept in the vault, always.';
  await ok(api.post('/api/render', { id: 'm-clean', html: `<p>${text}</p>` }), 'render');
  const anchor = rangeIn('m-clean', text, 'the staging host is kept');
  const h = (await ok(anonApi.post('/api/elements', { type: 'highlight', anchor, payload: { note: 'clean' } }), 'highlight')).element;
  const c = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor, payload: { text: 'clean', shared: true } }), 'comment')).element;
  const served = async () => {
    const b = (await anonApi.get('/api/elements')).json;
    return [h.id, c.id].map((id) => b.elements.find((e) => e.id === id));
  };
  const first = await served();
  for (const e of first) {
    assert.deepEqual(e.anchor, anchor, `${e.type}: the anchor is served as posted`);
    assert.ok(!('state' in e) && !('visible' in e) && !('explain' in e), `${e.type}: no served state`);
  }
  const other = `unrelated${crypto.randomBytes(10).toString('hex')}`;
  const probe = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor, payload: { text: `names ${other}`, shared: true } }), 'probe')).element;
  await learn(d, other, probe.id);
  const second = await served();
  assert.equal(JSON.stringify(second), JSON.stringify(first), 'byte-equal after a value is learned elsewhere');
});

// K.2-181 (c): the 0.8.5 legacy locator's text.
test('a comment posted with a legacy locator whose text holds a value learned later: GET, the frame and the committed node hold no fragment', async (t) => {
  const d = await withServer(t);
  const { api, anonApi, root } = d;
  const value = `wcloc${crypto.randomBytes(12).toString('hex')}`;
  const LEARNED = learned(value);
  await ok(api.post('/api/turn-begin', { message: 'pins' }), 'turn-begin');
  await ok(api.post('/api/render', { id: 'm-loc', html: '<p class="lead">Use the token now.</p>' }), 'render');
  const locator = { mount: 'm-loc', selector: 'p.lead', text: `Use ${value} now.`, ordinal: 0 };
  const engine = rangeIn('m-loc', 'Use the token now.', 'the token');
  // A comment on a legacy locator alone, and one with an engine record and the
  // locator beside it (the chrome's create: comments.js locatorOf).
  const legacy = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: locator, payload: { text: 'legacy', shared: true } }), 'legacy comment')).element;
  const beside = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: engine, locator, payload: { text: 'beside', shared: true } }), 'beside comment')).element;
  const probe = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: locator, payload: { text: `names ${value}`, shared: true } }), 'probe')).element;
  const nodeId = (await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end')).node_id;
  assert.ok(nodeId, 'a node was committed');
  const stored = fs.readFileSync(nodeFile(root, nodeId), 'utf8');
  assert.ok(stored.includes(value), 'precondition: the node file holds the locator as written');
  await learn(d, value, probe.id);
  const body = (await anonApi.get('/api/elements')).json;
  for (const id of [legacy.id, beside.id]) {
    const e = body.elements.find((x) => x.id === id);
    assert.ok(e, 'served');
    noLeaks(e, LEARNED, `GET's ${id}`);
    assert.ok(typeof e.anchor.text === 'string' && e.anchor.text.startsWith('Use ') && marksIn(e.anchor.text).length === 1, `the locator's text is masked, not dropped: ${JSON.stringify(e.anchor.text)}`);
  }
  noLeaks(body, LEARNED, 'the GET body');
  const got = await frames(t, d);
  await ok(anonApi.post(`/api/elements/${legacy.id}/reply`, { text: 'a reply' }), 'reply');
  const frame = await waitUntil(() => got.filter((f) => f.type === 'element:comment').pop(), { timeout: 5000, what: 'the comment frame' });
  noLeaks(frame, LEARNED, 'the comment frame');
  const nodeRead = await anonApi.get(`/api/graph/node/${nodeId}`);
  assert.equal(nodeRead.status, 200, nodeRead.text);
  noLeaks(nodeRead.text, LEARNED, 'the node read');
  assert.equal(fs.readFileSync(nodeFile(root, nodeId), 'utf8'), stored, 'the node file is never rewritten');
});

// K.2-181 (d): the event ring.
test('a shared pin\'s text, anchor and locator with a value learned after the write are served masked by GET /api/events and the stream; the ring entry unchanged', async (t) => {
  const d = await withServer(t);
  const { api, anonApi } = d;
  const value = `wcring${crypto.randomBytes(12).toString('hex')}`;
  const LEARNED = learned(value);
  const text = `Use ${value} for access to the staging host now.`;
  await ok(api.post('/api/render', { id: 'm-ring', html: '<p class="lead">Use the token now.</p>' }), 'render');
  const anchor = rangeIn('m-ring', text, `${value.slice(4)} for access`, text.indexOf(value) + 4);
  const locator = { mount: 'm-ring', selector: 'p.lead', text, ordinal: 0 };
  const pin = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor, locator, payload: { text: `the pin names ${value}`, shared: true } }), 'comment')).element;
  const ring = (await api.get('/api/events?since=0')).json.events.filter((e) => e.kind === 'comment' && e.pin && e.pin.id === pin.id);
  assert.ok(ring.length && findLeaks(JSON.stringify(ring), LEARNED).length, 'precondition: the ring entry holds the value');
  await learn(d, value, pin.id);
  for (const [who, client] of [['lib/client', api], ['a local browser', anonApi]]) {
    const r = await client.get('/api/events?since=0');
    assert.equal(r.status, 200, r.text);
    const mine = r.json.events.filter((e) => e.kind === 'comment' && e.pin && e.pin.id === pin.id);
    assert.ok(mine.length, `${who}: the entry is served`);
    noLeaks(pinEntries(r.json.events), LEARNED, `${who}: GET /api/events's comment and element entries`);
    assert.ok(mine[0].pin.text.startsWith('the pin names '), `${who}: the text is masked, not dropped: ${JSON.stringify(mine[0].pin.text)}`);
    assert.equal(mine[0].pin.state, 'masked', `${who}: the ring's pin reads masked`);
  }
  const stream = await d.sse({ since: 0 });
  t.after(() => stream.close());
  await waitUntil(() => stream.events.some((e) => e && e.kind === 'comment' && e.pin && e.pin.id === pin.id), { timeout: 5000, what: 'the stream\'s catch-up' });
  // A live entry too: a reply's.
  await ok(anonApi.post(`/api/elements/${pin.id}/reply`, { text: 'a reply' }), 'reply');
  await waitUntil(() => stream.events.some((e) => e && e.kind === 'comment' && e.op === 'reply'), { timeout: 5000, what: 'the live reply entry' });
  noLeaks(pinEntries(stream.events), LEARNED, 'the stream\'s comment and element entries');
  // The ring holds the entry as it was written: the masking is at serve.
  const held = d.srv.bus.read({ since: 0 }).events.filter((e) => e.kind === 'comment' && e.pin && e.pin.id === pin.id && e.op === 'add');
  assert.ok(held.length && JSON.stringify(held).includes(value), 'the ring\'s stored entry is unchanged');
});

// The two seams underneath: the redactor's widened head check and the read
// view's step 4 (lib/server/domain/elements.js maskQuoteContext).
test('knownFragmentAt: a text wholly inside a known value, or opening on its tail, answers the length and the value\'s mask; nothing else answers; the answer names no value', () => {
  const { createRedactor, MASK } = require('../lib/core/redact');
  const r = createRedactor();
  const v = `wcunit${'k3'.repeat(20)}zz`;
  r.addKnown(v, 'capture-token');
  const inside = v.slice(5, 30);
  assert.deepEqual(r.knownFragmentAt(inside), { n: inside.length, mark: MASK('capture-token') }, 'wholly inside');
  assert.deepEqual(r.knownFragmentAt(inside.toUpperCase()), { n: inside.length, mark: MASK('capture-token') }, 'case-insensitive');
  const tail = `${v.slice(-12)} and more`;
  assert.deepEqual(r.knownFragmentAt(tail), { n: 12, mark: MASK('capture-token') }, 'a tail opening the text: knownTailAt\'s length');
  assert.equal(r.knownTailAt(tail), 12, 'knownTailAt unchanged');
  assert.deepEqual(r.knownFragmentAt(v.slice(5, 12)), { n: 0, mark: null }, 'under 8 characters');
  assert.deepEqual(r.knownFragmentAt(`x${inside}`), { n: 0, mark: null }, 'an interior fragment that does not open the text');
  assert.deepEqual(r.knownFragmentAt('an ordinary sentence'), { n: 0, mark: null }, 'nothing known');
  assert.ok(!JSON.stringify(r.knownFragmentAt(inside)).includes(v.slice(5, 13)), 'the answer names no value');
  assert.deepEqual(createRedactor().knownFragmentAt(inside), { n: 0, mark: null }, 'a redactor that knows nothing');
});

test('maskQuoteContext step 4: a plain redact leaves exact; a check that throws or answers out of shape hides the window; a tail running on into the suffix cuts its head', () => {
  const { maskQuoteContext, quoteMasked } = require('../lib/server/domain/elements');
  const { createRedactor, MASK } = require('../lib/core/redact');
  const r = createRedactor();
  const v = `wcstep${crypto.randomBytes(30).toString('hex')}`;
  r.addKnown(v, 'capture-token');
  const red = Object.assign((s) => r.text(s), { tailAt: (s) => r.knownTailAt(s), fragmentAt: (s) => r.knownFragmentAt(s) });
  const q = { exact: v.slice(40, 52), prefix: v.slice(8, 40), suffix: v.slice(52, 84) };
  // A plain function has no check: exact as step 1 left it.
  const plain = maskQuoteContext(q, (s) => r.text(s));
  assert.equal(plain.exact, q.exact);
  // A throw, or an answer out of shape, fails closed.
  for (const bad of [() => { throw new Error('x'); }, () => ({ n: 3, mark: 'x' }), () => ({ n: 9, mark: 'not a mark' }), () => null]) {
    const out = maskQuoteContext(q, Object.assign((s) => s, { tailAt: () => 0, fragmentAt: bad }));
    assert.deepEqual(out, { exact: MASK('secret'), prefix: '', suffix: '' }, `fails closed on ${bad}`);
    assert.ok(quoteMasked({ quote: out }));
  }
  // The window opens on the value's tail, which runs through exact into the
  // suffix: exact is the mask, the prefix goes, the suffix keeps what follows.
  const text = `${v.slice(10)} — and the rest of the line follows here.`;
  const at = v.length - 10 - 20;
  const run = { exact: text.slice(at, at + 12), prefix: text.slice(at - 32, at), suffix: text.slice(at + 12, at + 44) };
  const out = maskQuoteContext(run, red);
  assert.equal(out.exact, MASK('capture-token'));
  assert.equal(out.prefix, '');
  assert.equal(out.suffix, run.suffix.slice(8), `the suffix keeps what follows the value: ${JSON.stringify(out.suffix)}`);
  assert.deepEqual(findLeaks(JSON.stringify(out), learned(v)), []);
  // No context: exact alone, inside the value.
  assert.equal(maskQuoteContext({ exact: v.slice(20, 40), prefix: '', suffix: '' }, red).exact, MASK('capture-token'));
  // A clean quote is returned equal.
  const clean = { exact: 'the staging host', prefix: 'about ', suffix: ' is kept' };
  assert.deepEqual(maskQuoteContext(clean, red), clean);
  assert.equal(quoteMasked({ quote: clean }), false);
});

// K.2-182 g10: a queue item quotes its pin's words as queued; served now.
test('a shared pin queued, then its value learned: GET /api/events\' queue entry and GET /api/queue hold no fragment of it; the stored item is unchanged', async (t) => {
  const d = await withServer(t);
  const { api, anonApi, srv } = d;
  const value = `wcqueue${crypto.randomBytes(12).toString('hex')}`;
  const LEARNED = learned(value);
  await ok(api.post('/api/render', { id: 'm-q', html: '<p class="lead">The pin names the token here.</p>' }), 'render');
  const anchor = rangeIn('m-q', 'The pin names the token here.', 'the token');
  const pin = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor, payload: { text: `the pin names ${value}`, shared: true } }), 'pin')).element;
  const queued = srv.state.queue.find((it) => it.kind === 'element' && (it.element_ids || [it.element_id]).includes(pin.id));
  assert.ok(queued && JSON.stringify(queued).includes(value), 'precondition: the queued item quotes the value as written');
  const ringBefore = (await ok(api.get('/api/events?since=0'), 'events before')).events.filter((e) => e.kind === 'queue');
  assert.ok(ringBefore.some((e) => JSON.stringify(e).includes(value)), 'precondition: the ring\'s queue entry quotes it before it is learned');
  await learn(d, value, pin.id);
  const ring = (await ok(api.get('/api/events?since=0'), 'events')).events;
  const entries = ring.filter((e) => e.kind === 'queue' && e.item);
  assert.ok(entries.length >= 1, 'a queue entry');
  for (const e of entries) noLeaks(e, LEARNED, `the queue entry ${e.id}`);
  const q = await ok(api.get('/api/queue'), 'GET /api/queue');
  assert.ok(q.items.some((it) => (it.element_ids || [it.element_id]).includes(pin.id)), 'the item is still queued');
  noLeaks(q, LEARNED, 'GET /api/queue');
  assert.ok(JSON.stringify(srv.state.queue).includes(value), 'the stored item is unchanged (masked at serve only)');
});

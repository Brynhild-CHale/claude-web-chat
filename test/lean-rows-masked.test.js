// The lean element rows go through the read view (U415e; DECISIONS K.2-186,
// form 8 Z1 = a, Z2 = a; D4, X3, Y3). The hello's and every reset's
// `elements` and a node read's `lean_elements` (lib/server/domain/
// element-projection leanElements) are what the chrome draws a pin from on a
// surface's first frame and on a previewed node. A value the redactor learns
// after a pin was made is never served anywhere a pin's text goes, and the
// pin reads masked; the stored bytes stay as written:
//   - a pin whose words (exact) open on a learned value's tail, and one whose
//     whole window lies inside a long learned value: the hello, a reset and
//     GET /api/graph/node/:id's lean_elements hold no fragment of it
//     (findLeaks), and the row reads state 'masked' (visible, explain:
//     anchor-states' 'masked' row);
//   - a pin with no learned value: its row is served byte-equal (the lean
//     keys only, its anchor as posted);
//   - a copy the log cannot map (projected from its own anchor): the same
//     read view.
// Red at e55cb0f3 on the masked state of every masked row.

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
const { leanElements } = require('../lib/server/domain/element-projection');

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const ROW_KEYS = ['anchor', 'answered', 'id', 'replies', 'schema', 'shared', 'type', 'v'];
const MASKED_KEYS = [...ROW_KEYS, 'explain', 'state', 'visible'].sort();
const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const nodeFile = (root, id) => path.join(projectPaths(root).graphDir, `${id}.json`);
const near = (hay, leaks) => leaks.map((l) => hay.slice(Math.max(0, l.at - 80), l.at + 40)).join(' | ');
const learned = (...values) => [{ id: 'learned', rule: 'known', secrets: values }];
const noLeaks = (body, LEARNED, what) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const leaks = findLeaks(raw, LEARNED);
  assert.deepEqual(leaks, [], `${what} holds no fragment of the value: ${near(raw, leaks)}`);
};

// A range anchor cut out of `text` as the chrome cuts one (32 characters of
// context each side).
function rangeIn(mount, text, exact, at = text.indexOf(exact)) {
  const quote = { exact, prefix: text.slice(Math.max(0, at - 32), at), suffix: text.slice(at + exact.length, at + exact.length + 32) };
  return { v: 1, kind: 'range', mount, quote, pos: { start: at, end: at + exact.length } };
}

// The redactor learns `value` through the capture token's file (a known
// source); `probeId` is a pin whose text names it whole, masked once known.
async function learn(d, value, probeId) {
  fs.writeFileSync(projectPaths(d.root).captureToken, value + '\n');
  await waitUntil(async () => {
    const b = (await d.anonApi.get('/api/elements')).json;
    const p = ((b && b.elements) || []).find((e) => e.id === probeId);
    return p && typeof p.text === 'string' && !p.text.includes(value);
  }, { timeout: 6000, what: 'the redactor learned the value' });
}

// A local socket's frames, collected.
async function socket(t, d) {
  const got = [];
  const sock = d.ws();
  sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  await waitUntil(() => got.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
  return { got, of: (type) => got.filter((f) => f.type === type) };
}

function assertMaskedRow(row, what) {
  assert.ok(row, `${what}: served`);
  assert.deepStrictEqual(Object.keys(row).sort(), MASKED_KEYS, `${what}: the lean keys and the served state, nothing else`);
  assert.equal(row.state, 'masked', `${what}: the row reads masked`);
  assert.equal(row.visible, 'masked', `${what}: visible`);
  assert.equal(row.explain, EXPLAIN.masked, `${what}: the masked line`);
  const exact = row.anchor && row.anchor.quote && row.anchor.quote.exact;
  assert.ok(typeof exact === 'string' && marksIn(exact).length >= 1, `${what}: the pinned words are served masked: ${JSON.stringify(exact)}`);
}

// One world: a pane; in turn 1 a tail pin, an inside pin (comment and
// highlight each), a clean pin and the probes, committed as node A; turn 2
// adds a pane, committed as node B (so a Set active A is a restore and sends a
// reset). Then the redactor learns both values.
async function world(t) {
  const d = await withServer(t);
  const { api, anonApi } = d;
  const value = `wclean${crypto.randomBytes(12).toString('hex')}`;
  const long = `wcllong${crypto.randomBytes(48).toString('hex')}`;
  const text = `Use ${value} for access to the staging host now. Key ${long} ends here.`;
  const cleanText = 'Configuration information about the staging host is kept in the vault, always.';
  await ok(api.post('/api/turn-begin', { message: 'pins' }), 'turn-begin');
  await ok(api.post('/api/render', { id: 'm-lean', html: '<p>Use the token for access to the staging host now.</p>' }), 'render');
  const tail = rangeIn('m-lean', text, `${value.slice(4)} for access`, text.indexOf(value) + 4);
  const inside = rangeIn('m-lean', text, long.slice(40, 52), text.indexOf(long) + 40);
  const clean = rangeIn('m-lean', cleanText, 'the staging host is kept');
  assert.ok(findLeaks(tail.quote.exact, learned(value)).length && !findLeaks(tail.quote.prefix, learned(value)).length, 'precondition: exact opens on the value\'s tail');
  assert.ok(long.includes(inside.quote.prefix + inside.quote.exact + inside.quote.suffix), 'precondition: the window lies wholly inside the long value');
  const post = async (body, what) => (await ok(anonApi.post('/api/elements', body), what)).element;
  const ids = {
    tail: (await post({ type: 'comment', anchor: tail, payload: { text: 'tail', shared: true } }, 'tail comment')).id,
    inside: (await post({ type: 'comment', anchor: inside, payload: { text: 'inside', shared: true } }, 'inside comment')).id,
    hl: (await post({ type: 'highlight', anchor: tail, payload: { note: 'tail' } }, 'tail highlight')).id,
    clean: (await post({ type: 'comment', anchor: clean, payload: { text: 'clean', shared: true } }, 'clean comment')).id,
  };
  const p1 = (await post({ type: 'comment', anchor: clean, payload: { text: `names ${value}`, shared: true } }, 'probe')).id;
  const p2 = (await post({ type: 'comment', anchor: clean, payload: { text: `names ${long}`, shared: true } }, 'probe long')).id;
  const nodeA = (await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end A')).node_id;
  assert.ok(nodeA, 'node A was committed');
  await ok(api.post('/api/turn-begin', { message: 'more' }), 'turn-begin B');
  await ok(api.post('/api/render', { id: 'm-more', html: '<p>more</p>' }), 'render B');
  const nodeB = (await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end B')).node_id;
  assert.ok(nodeB && nodeB !== nodeA, 'node B was committed');
  // The clean row as the base projection gave it, before anything is learned.
  const cleanBefore = leanElements(d.srv.state, d.srv.elements).find((r) => r.id === ids.clean);
  const storedA = fs.readFileSync(nodeFile(d.root, nodeA), 'utf8');
  const logBefore = logBytes(d.root);
  assert.ok(storedA.includes(tail.quote.exact) && logBefore.includes(inside.quote.exact), 'precondition: stored as written');
  await learn(d, value, p1);
  await learn(d, long, p2);
  return { ...d, value, long, tail, inside, clean, ids, nodeA, nodeB, cleanBefore, storedA, logBefore, LEARNED: learned(value, long) };
}

// The rows of a frame or a node read: every masked one masked, the clean one
// byte-equal to the base projection's, the whole list leak-free.
function checkRows(w, rows, what) {
  assert.ok(Array.isArray(rows), `${what}: a list of rows`);
  noLeaks(rows, w.LEARNED, what);
  const by = new Map(rows.map((r) => [r.id, r]));
  assertMaskedRow(by.get(w.ids.tail), `${what}: the tail comment`);
  assertMaskedRow(by.get(w.ids.inside), `${what}: the inside comment`);
  const c = by.get(w.ids.clean);
  assert.ok(c, `${what}: the clean pin is served`);
  assert.deepStrictEqual(Object.keys(c).sort(), ROW_KEYS, `${what}: the clean pin carries the lean keys only`);
  assert.deepEqual(c.anchor, w.clean, `${what}: the clean pin's anchor is served as posted`);
  assert.equal(JSON.stringify(c), JSON.stringify(w.cleanBefore), `${what}: the clean row is byte-equal`);
  return by;
}

test('the hello after a value is learned: no lean row holds a fragment of it, the rows over it read masked, a clean row byte-equal', async (t) => {
  const w = await world(t);
  const s = await socket(t, w);
  const hello = s.of('hello')[0];
  const by = checkRows(w, hello.elements, 'the hello');
  // A reference (the highlight, an id@v row from the log) goes through the same view.
  const hl = [...by.values()].find((r) => r.type === 'highlight');
  assertMaskedRow(hl, 'the hello: the tail highlight');
  noLeaks(hello, w.LEARNED, 'the whole hello');
  assert.equal(logBytes(w.root), w.logBefore, 'the log bytes are unchanged');
  const held = w.srv.state.comments.find((p) => p.id === w.ids.tail);
  assert.deepEqual(held.anchor.quote, w.tail.quote, 'the live pin itself is unchanged');
  assert.ok(!('state' in held), 'the live pin carries no served state');
});

test('a reset (Set active over a node holding the pins) after a value is learned: no lean row holds a fragment of it, the rows over it read masked', async (t) => {
  const w = await world(t);
  const s = await socket(t, w);
  const n = s.of('reset').length;
  await ok(w.api.post('/api/graph/active', { id: w.nodeA }), 'set active A');
  await waitUntil(() => s.of('reset').length > n, { timeout: 6000, what: 'the reset' });
  const reset = s.of('reset').at(-1);
  checkRows(w, reset.elements, 'the reset');
  noLeaks(reset, w.LEARNED, 'the whole reset');
  assert.equal(fs.readFileSync(nodeFile(w.root, w.nodeA), 'utf8'), w.storedA, 'the node file is never rewritten');
});

test('GET /api/graph/node/:id after a value is learned: lean_elements hold no fragment of it and the rows over it read masked; the node file unchanged', async (t) => {
  const w = await world(t);
  for (const [who, client] of [['a local browser', w.anonApi], ['lib/client', w.api]]) {
    const r = await client.get(`/api/graph/node/${w.nodeA}`);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    checkRows(w, r.json.lean_elements, `${who}: lean_elements`);
    noLeaks(r.text, w.LEARNED, `${who}: the node read`);
  }
  assert.equal(fs.readFileSync(nodeFile(w.root, w.nodeA), 'utf8'), w.storedA, 'the node file is never rewritten');
});

test('a copy the log cannot map is projected through the same read view; no store serves the copy as stored; a mask that fails serves no anchor', async (t) => {
  const w = await world(t);
  const orphan = { id: 'c9999', v: 77, text: 'orphan', shared: true, anchor: w.tail, replies: [] };
  const state = { comments: [orphan] };
  const [row] = leanElements(state, w.srv.elements);
  assertMaskedRow(row, 'the unmapped copy');
  noLeaks(row, w.LEARNED, 'the unmapped copy');
  // A committed node's copies, already through the read view (graph.js
  // maskedNode): taken as served, never masked twice.
  const served = w.srv.elements.maskPins([orphan]);
  const [nodeRow] = leanElements({ id: 'nx', comments: served }, w.srv.elements, { node: true, masked: true });
  assert.deepEqual(nodeRow.anchor, served[0].anchor, 'a served copy\'s anchor is taken as served');
  assertMaskedRow(nodeRow, 'the served node copy');
  // No store: the copy as stored (a bare rig).
  assert.deepEqual(leanElements(state, null)[0].anchor, w.tail, 'no store: the copy as stored');
  // A store whose mask throws or answers out of shape: the row stays, its anchor does not.
  for (const maskPins of [() => { throw new Error('x'); }, () => [], () => null]) {
    const [r] = leanElements(state, { version: () => null, maskPins });
    assert.equal(r.anchor, null, `a failing mask serves no anchor (${maskPins})`);
    assert.ok(!('state' in r));
  }
});

// The node read's lean rows are built from the MASKED node (graph.js
// maskedNode), so a copy the log cannot map is served through the read view
// over HTTP too: never the raw node's copy claimed as served.
test('GET /api/graph/node/:id: a node copy the log cannot map is served masked in lean_elements', async (t) => {
  const w = await world(t);
  const node = w.srv.graph.nodes.get(w.nodeA);
  const orphan = { id: 'c9999', v: 77, text: 'orphan', shared: true, anchor: w.tail, replies: [] };
  node.comments = [...node.comments, orphan];
  const r = await w.anonApi.get(`/api/graph/node/${w.nodeA}`);
  assert.equal(r.status, 200, r.text);
  const row = (r.json.lean_elements || []).find((e) => e.id === 'c9999');
  assertMaskedRow(row, 'the unmapped node copy');
  noLeaks(r.json.lean_elements, w.LEARNED, 'lean_elements');
  noLeaks(r.text, w.LEARNED, 'the node read');
});

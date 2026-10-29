// Learned-later masking on a committed node (U415b; DECISIONS K.2-176, D4,
// C-13). A node's comments[] are the copies its commit took, their text and
// anchor quotes as written. GET /api/graph/node/:id and GET /preview/node/:id
// hand them out through the element store's read view (maskPins, lib/server/
// routes/graph.js maskedNode): a value the redactor learns AFTER the commit —
// whole in a pin's text, or a fragment of it cut at the edge of the pin's quote
// prefix — is masked at every read, local included, and the node file on disk
// is never rewritten. Red with the maskedNode call removed from either route.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const { findLeaks } = require('../test-support/fake-secrets');
const { projectPaths } = require('../lib/core/paths');

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const nodeFile = (root, id) => path.join(projectPaths(root).graphDir, `${id}.json`);
const near = (hay, leaks) => leaks.map((l) => hay.slice(Math.max(0, l.at - 80), l.at + 40)).join(' | ');

// A range pin beside the value (its 32-character prefix holds the value's
// tail, its text the value whole), committed into a node; then the redactor
// learns the value (the capture token's file, a known source).
async function committedBeside(t) {
  const d = await withServer(t);
  const { api, anonApi, root } = d;
  const value = `wcnode${crypto.randomBytes(12).toString('hex')}`;
  const LEARNED = [{ id: 'learned', rule: 'known', secrets: [value] }];
  const text = `Use ${value} for access to the staging host now.`;
  await ok(api.post('/api/turn-begin', { message: 'pins' }), 'turn-begin');
  // The pane's own html does not hold the value (a pane's content is not a
  // pin's, and not this test's): the quote is cut out of `text` as the
  // chrome cuts one out of the pane's.
  await ok(api.post('/api/render', { id: 'm-node', html: '<p>Use the token for access to the staging host now.</p>' }), 'render');
  const exact = 'to the staging host';
  const i = text.indexOf(exact);
  const quote = { exact, prefix: text.slice(Math.max(0, i - 32), i), suffix: text.slice(i + exact.length, i + exact.length + 32) };
  assert.ok(!quote.prefix.includes(value) && findLeaks(quote.prefix, LEARNED).length, 'precondition: the prefix holds the value\'s tail');
  const anchor = { v: 1, kind: 'range', mount: 'm-node', quote, pos: { start: i, end: i + exact.length } };
  const pin = (await ok(anonApi.post('/api/elements', {
    type: 'comment', anchor, payload: { text: `the pin names ${value}`, shared: true },
  }), 'comment')).element;
  const nodeId = (await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end')).node_id;
  assert.ok(nodeId, 'a node was committed');
  const stored = fs.readFileSync(nodeFile(root, nodeId), 'utf8');
  assert.ok(stored.includes(value) && stored.includes(quote.prefix), 'precondition: the node file holds the copy as written');
  fs.writeFileSync(projectPaths(root).captureToken, value + '\n');
  // The live pin's text holds the value whole: once GET masks it, the redactor knows it.
  await waitUntil(async () => {
    const b = (await anonApi.get('/api/elements')).json;
    const live = ((b && b.elements) || []).find((e) => e.id === pin.id);
    return live && typeof live.text === 'string' && !live.text.includes(value);
  }, { timeout: 6000, what: 'the redactor learned the value' });
  return { ...d, value, LEARNED, quote, nodeId, pinId: pin.id, stored };
}

test('a range pin committed into a node, the value learned after the commit: GET /api/graph/node/:id holds no fragment of it, and the node file is unchanged', async (t) => {
  const w = await committedBeside(t);
  for (const [who, client] of [['a local browser', w.anonApi], ['lib/client', w.api]]) {
    const r = await client.get(`/api/graph/node/${w.nodeId}`);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    const leaks = findLeaks(r.text, w.LEARNED);
    assert.deepEqual(leaks, [], `${who}: the node read holds no fragment of the value: ${near(r.text, leaks)}`);
    const copy = (r.json.comments || []).find((c) => c && c.id === w.pinId);
    assert.ok(copy, `${who}: the node read still carries the copy`);
    assert.ok(typeof copy.text === 'string' && copy.text.startsWith('the pin names '), `${who}: the copy's text is masked, not dropped: ${JSON.stringify(copy.text)}`);
    const q = copy.anchor.quote;
    assert.equal(q.exact, w.quote.exact, `${who}: exact is untouched`);
    assert.ok(w.quote.prefix.endsWith(q.prefix) && q.prefix.includes('for access'), `${who}: the prefix keeps the words beside the passage: ${JSON.stringify(q.prefix)}`);
    assert.equal(q.suffix, w.quote.suffix, `${who}: a clean suffix is served as stored`);
  }
  assert.equal(fs.readFileSync(nodeFile(w.root, w.nodeId), 'utf8'), w.stored, 'the node file is never rewritten');
});

test('a range pin committed into a node, the value learned after the commit: GET /preview/node/:id embeds no fragment of it', async (t) => {
  const w = await committedBeside(t);
  for (const [who, client] of [['a local browser', w.anonApi], ['lib/client', w.api]]) {
    const r = await client.get(`/preview/node/${w.nodeId}`);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    const leaks = findLeaks(r.text, w.LEARNED);
    assert.deepEqual(leaks, [], `${who}: the preview document holds no fragment of the value: ${near(r.text, leaks)}`);
    assert.ok(r.text.includes('the pin names '), `${who}: the preview still embeds the copy`);
  }
});

// The head check reads the whole window (prefix + exact + suffix), not the
// prefix alone: a learned value that began before the window and runs on past
// the prefix into exact has no tail inside the prefix, so only the window
// shows it, and the whole prefix goes (lib/server/domain/elements.js
// maskQuoteContext step 3). The node read and the preview serve each copy's
// quote through this mask. Red with the head check handed the prefix alone.
test('a learned value whose tail runs from a cut prefix on into exact: the prefix holds no fragment of it', () => {
  const { createRedactor } = require('../lib/core/redact');
  const { maskQuoteContext } = require('../lib/server/domain/elements');
  const r = createRedactor();
  const value = `wcspan${crypto.randomBytes(20).toString('hex')}`;
  const LEARNED = [{ id: 'learned', rule: 'known', secrets: [value] }];
  r.addKnown(value, 'token');
  const redact = Object.assign((t) => r.text(t), { tailAt: (t) => r.knownTailAt(t) });
  const text = `Use ${value} for access to the staging host now.`;
  const start = text.indexOf(value) + 10;          // the prefix opens 10 characters into the value
  const i = start + 32;                            // and exact opens inside it too
  const quote = { exact: text.slice(i, i + 24), prefix: text.slice(start, i), suffix: text.slice(i + 24, i + 56) };
  assert.ok(value.length - 10 > 32 && findLeaks(quote.prefix, LEARNED).length, 'precondition: the prefix is all value, and the value runs on into exact');
  const served = maskQuoteContext(quote, redact);
  assert.deepEqual(findLeaks(served.prefix, LEARNED), [], `the prefix holds no fragment: ${JSON.stringify(served.prefix)}`);
  assert.equal(served.exact, r.text(quote.exact), 'exact is the redactor\'s own pass (a fragment inside it is out of scope, U415a)');
});

'use strict';
// A comment chained on a highlight carries the chain root's quote as its queue
// item's excerpt (K.2-180 g6, form 7 X4 = a, Y4 = a; U422's excerpt rule over
// U406's comment@2 chain): through the real createServer, the excerpt switch
// on (lib/core/excerpts setSwitch on the test's own root).
//   * a comment on a pane element (a locator: no quote of its own) chained on
//     a SHARED highlight queues with the highlight's quote as its excerpt, and
//     the parked envelope's block carries it under the comment's id;
//   * chained on a PRIVATE highlight it carries none (Claude's tools are below
//     seesPrivate, U406a) — nor does the envelope hold the private passage;
//   * a comment on a pane element with no chain carries none, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('../test-support/helpers');
const { setSwitch } = require('../lib/core/excerpts');
const { EXCERPT_PREFIX } = require('../lib/channel/envelope');

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const RANGE = (mount, exact, start) => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start, end: start + exact.length } });
const LOCATOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const groupOf = (items, id) => items.find((it) => it.kind === 'element' && (it.element_ids || [it.element_id]).includes(id));
const excerptOf = (it, id) => (Array.isArray(it && it.excerpt) ? it.excerpt.find((e) => e.id === id) : null);

test('a comment chained on a shared highlight carries its quote as the excerpt; on a private one none; unchained none', async (t) => {
  const { api, srv, root } = await withServer(t);
  setSwitch(root, true);
  const text = 'Hello the shared passage and the private passage here';
  await ok(api.post('/api/render', { id: 'm1', html: `<p class="lead">${text}</p>` }), 'render');
  const shared = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE('m1', 'the shared passage', text.indexOf('the shared passage')), payload: { color: 'gold', note: 'n' } }), 'shared highlight')).element;
  const priv = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE('m1', 'the private passage', text.indexOf('the private passage')), payload: { color: 'gold', note: 'p', shared: false } }), 'private highlight')).element;

  const onShared = (await ok(api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'on the shared one', shared: true, chain: [shared.id] } }), 'chained on shared')).pin;
  const onPrivate = (await ok(api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'on the private one', shared: true, chain: [priv.id] } }), 'chained on private')).pin;
  const bare = (await ok(api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'no chain', shared: true } }), 'unchained')).pin;

  const g = groupOf(srv.state.queue, onShared.id);
  assert.ok(g, 'the chained comment queued');
  assert.deepEqual(excerptOf(g, onShared.id), { id: onShared.id, text: 'the shared passage' }, 'the chain root\'s quote is its excerpt');
  assert.equal(excerptOf(groupOf(srv.state.queue, onPrivate.id), onPrivate.id) || null, null, 'a private root gives none');
  assert.equal(excerptOf(groupOf(srv.state.queue, bare.id), bare.id) || null, null, 'no chain, no quote of its own: none');

  const pushed = await ok(api.post('/api/queue/push', {}), 'push');
  assert.equal(pushed.mode, 'parked', JSON.stringify(pushed));
  const content = (await ok(api.get('/api/queue/pending'), 'pending')).pending.envelope.content;
  assert.ok(content.includes(`comment ${onShared.id}\n${EXCERPT_PREFIX}the shared passage`), `the block carries it under the comment: ${content}`);
  assert.ok(!content.includes('the private passage'), 'the private passage never reaches the envelope');
  assert.ok(!content.includes(`comment ${onPrivate.id}\n${EXCERPT_PREFIX}`) && !content.includes(`comment ${bare.id}\n${EXCERPT_PREFIX}`), 'no block entry for either');
});

test('with the switch off a chained comment carries no excerpt (ids only)', async (t) => {
  const { api, srv, root } = await withServer(t);
  setSwitch(root, false);
  const text = 'Hello the shared passage';
  await ok(api.post('/api/render', { id: 'm1', html: `<p class="lead">${text}</p>` }), 'render');
  const shared = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE('m1', 'the shared passage', 6), payload: { color: 'gold', note: 'n' } }), 'highlight')).element;
  const c = (await ok(api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'chained', shared: true, chain: [shared.id] } }), 'comment')).pin;
  const g = groupOf(srv.state.queue, c.id);
  assert.ok(g, 'queued');
  assert.equal(excerptOf(g, c.id) || null, null, 'off: none');
});

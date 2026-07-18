// Opt-out activity routing — undeclared pane interactions (delegated dom events
// + undeclared browser store writes) coalesce into ONE rolling 'activity' queue
// item per mount, so user activity reaches the queue even when a pane's own
// script is broken (the delegated listeners live in the shell, not the pane).
// Values never ride items; service-owned panes default out (params.routing
// opts out / back in). See lib/channel/policy + lib/server/domain/queue.coalesce.

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { withServer } = require('../test-support/helpers');
const { classify, activityItem, mergeActivity } = require('../lib/channel/policy');
const { deriveRouting } = require('../lib/server/domain/signals');

// ── unit: classify / merge ───────────────────────────────────────────────────

test('classify: a dom change/submit always coalesces; clicks only on affordances', () => {
  const ctx = { signals: {}, routing: {} };
  assert.equal(classify({ kind: 'dom', type: 'change', mountId: 'm1', tag: 'TEXTAREA' }, ctx).action, 'coalesce');
  assert.equal(classify({ kind: 'dom', type: 'submit', mountId: 'm1', tag: 'FORM' }, ctx).action, 'coalesce');
  assert.equal(classify({ kind: 'dom', type: 'click', mountId: 'm1', tag: 'BUTTON' }, ctx).action, 'coalesce');
  assert.equal(classify({ kind: 'dom', type: 'click', mountId: 'm1', tag: 'DIV', dataset: { act: 'go' } }, ctx).action, 'coalesce');
  // a bare click on prose is not a handoff-worthy interaction
  assert.equal(classify({ kind: 'dom', type: 'click', mountId: 'm1', tag: 'DIV' }, ctx), null);
  assert.equal(classify({ kind: 'dom', type: 'click', mountId: 'm1', tag: 'P', dataset: {} }, ctx), null);
});

test('classify: dom values never leak into the activity summary', () => {
  const r = classify({ kind: 'dom', type: 'change', mountId: 'm1', tag: 'INPUT', value: 'hunter2' }, { signals: {}, routing: {} });
  assert.doesNotMatch(r.item.summary, /hunter2/);
});

test('mergeActivity: sums counts, unions keys, rebuilds the summary', () => {
  const base = activityItem({ kind: 'dom', type: 'click', mountId: 'm1', tag: 'BUTTON', seq: 1 });
  mergeActivity(base, activityItem({ kind: 'dom', type: 'change', mountId: 'm1', tag: 'INPUT', seq: 2 }));
  mergeActivity(base, activityItem({ kind: 'store', patch: { a: 1, b: 2 }, source: 'browser', mount: 'm1', seq: 3 }));
  assert.deepEqual(base.counts, { click: 1, change: 1, submit: 0, store: 1 });
  assert.deepEqual(base.keys, ['a', 'b']);
  assert.equal(base.seq, 3);
  assert.match(base.summary, /m1/);
  assert.match(base.summary, /1 edit/);
  assert.match(base.summary, /1 click/);
  assert.match(base.summary, /keys: a, b/);
});

test('deriveRouting: service-owned panes default out; params.routing overrides both ways', () => {
  const state = { mounts: new Map([
    ['plain', { params: {} }],
    ['svc', { owner: 'service:git', params: {} }],
    ['svc-optin', { owner: 'service:git', params: { routing: 'auto' } }],
    ['muted', { params: { routing: 'none' } }],
  ]) };
  assert.deepEqual(deriveRouting(state), { plain: 'auto', svc: 'none', 'svc-optin': 'auto', muted: 'none' });
});

// ── integration: the rolling per-mount item ──────────────────────────────────

function wsOpen(port) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') resolve(sock);
    });
    sock.on('error', reject);
  });
}
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

test('activity: dom events + undeclared store writes fold into ONE rolling item per mount', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'form-a', html: '<div>x</div>' });
  await api.post('/api/render', { id: 'form-b', html: '<div>y</div>' });

  const sock = await wsOpen(port);
  const domEvent = (payload) => sock.send(JSON.stringify({ type: 'event', payload }));
  domEvent({ type: 'click', mountId: 'form-a', tag: 'BUTTON' });
  domEvent({ type: 'click', mountId: 'form-a', tag: 'BUTTON' });
  domEvent({ type: 'change', mountId: 'form-a', tag: 'INPUT', value: 'secret draft' });
  sock.send(JSON.stringify({ type: 'store:set', patch: { draft: 'text' }, mount: 'form-a', gesture: true }));
  // a script init write (no gesture stamp) must NOT count as user activity
  sock.send(JSON.stringify({ type: 'store:set', patch: { init_seed: 1 }, mount: 'form-a' }));
  domEvent({ type: 'click', mountId: 'form-b', tag: 'BUTTON' });
  await settle();
  sock.close();

  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 2, 'one rolling item per mount, not one per event');
  const a = q.json.items.find((it) => it.origin_mount === 'form-a');
  const b = q.json.items.find((it) => it.origin_mount === 'form-b');
  assert.equal(a.kind, 'activity');
  assert.deepEqual(a.counts, { click: 2, change: 1, submit: 0, store: 1 });
  assert.deepEqual(a.keys, ['draft']);
  assert.doesNotMatch(a.summary, /secret draft/, 'values never ride the item');
  assert.deepEqual(b.counts, { click: 1, change: 0, submit: 0, store: 0 });
});

test('activity: a service-owned pane is routed out by default', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'dash', html: '<div>x</div>', owner: 'service:git' });

  const sock = await wsOpen(port);
  sock.send(JSON.stringify({ type: 'event', payload: { type: 'click', mountId: 'dash', tag: 'BUTTON' } }));
  sock.send(JSON.stringify({ type: 'store:set', patch: { git_ctl: { op: 'log' } }, mount: 'dash', gesture: true }));
  await settle();
  sock.close();

  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 0, 'service pane control traffic never enqueues');
});

test('activity: flush delivers the rolling item and resets coalescing', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p', html: '<div>x</div>' });

  const sock = await wsOpen(port);
  sock.send(JSON.stringify({ type: 'event', payload: { type: 'change', mountId: 'p', tag: 'INPUT' } }));
  await settle();
  await api.post('/api/queue/push', {});
  sock.send(JSON.stringify({ type: 'event', payload: { type: 'change', mountId: 'p', tag: 'INPUT' } }));
  await settle();
  sock.close();

  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 1, 'post-push activity starts a fresh rolling item');
  assert.deepEqual(q.json.items[0].counts, { click: 0, change: 1, submit: 0, store: 0 });
});

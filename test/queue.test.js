// Commit 2 — the queue domain + routes + boot classify subscriber + draft
// persistence. Integration via a real in-process daemon (captures drive the
// queue) plus domain unit tests for the immediate-wake / multi-item paths that
// need no HTTP.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');
const { createBus } = require('../lib/core/bus');
const { subscribeSSE } = require('../lib/client');
const queue = require('../lib/server/domain/queue');

const HTML = '<html><head><title>Doc</title></head><body><p>hi</p></body></html>';

// Default freshState is CONNECTED (wakeConsumers: 1) so a domain flush WAKES — the
// parked path is exercised by the explicit wakeConsumers:0 tests below.
function freshState() {
  return { queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {}, wakeConsumers: 1, wakeConsumerSeenAt: Date.now(), pendingAck: null, pendingWake: null, pendingWakeSeq: 0 };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeout = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await pred()) return true; await settle(15); }
  return await pred();
}
// A wake-filtered SSE consumer makes state.wakeConsumers > 0 — i.e. "a channel is
// connected", so a Push WAKES rather than parks. Returns a close handle.
async function connectChannel(api, port) {
  const h = subscribeSSE({ port, kinds: ['wake'] });
  await waitUntil(async () => (await api.get('/api/queue/policy')).json.channel_connected);
  return h;
}

// ── integration: captures fold into the queue ────────────────────────────────

test('queue: a capture folds into the queue as one item', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });

  const { json } = await api.get('/api/queue');
  assert.equal(json.count, 1);
  assert.equal(json.items.length, 1);
  const it = json.items[0];
  assert.equal(it.kind, 'capture');
  assert.equal(it.capture_id, 'cap1');
  assert.equal(it.id, 'q1');
  assert.match(it.summary, /example\.com/);
});

test('queue: a server-sourced store write does NOT enqueue (self-wake safety)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/store', { patch: { form_submit: { seq: 1 } } }); // source:'server'
  const { json } = await api.get('/api/queue');
  assert.equal(json.count, 0);
});

test('queue: push flushes into exactly ONE wake event and clears the queue', async (t) => {
  const { api, port } = await withServer(t);
  // a Push only WAKES when a channel is connected; otherwise it parks. Connect
  // a wake-consumer first so this exercises the live-wake path.
  const ch = await connectChannel(api, port);
  t.after(() => ch.close());
  await api.post('/api/capture', { url: 'https://a.com/1', title: 'A', html: HTML });
  await api.post('/api/capture', { url: 'https://b.com/2', title: 'B', html: HTML });

  const before = await api.get('/api/queue');
  assert.equal(before.json.count, 2);

  const push = await api.post('/api/queue/push', {});
  assert.equal(push.json.ok, true);
  assert.equal(push.json.pushed, 2);
  assert.equal(push.json.mode, 'wake');
  assert.ok(push.json.seq > 0);

  const after = await api.get('/api/queue');
  assert.equal(after.json.count, 0, 'queue cleared after push');

  // Exactly one wake event, carrying the 2-item batch.
  const ev = await api.get('/api/events');
  const wakes = ev.json.events.filter((e) => e.kind === 'wake');
  assert.equal(wakes.length, 1, 'exactly one wake per push');
  assert.equal(wakes[0].batch.length, 2);
  assert.equal(wakes[0].reason, 'push');
  assert.equal(wakes[0].source, 'queue');
});

test('queue: remove drops one item by id', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/capture', { url: 'https://a.com/1', title: 'A', html: HTML });
  await api.post('/api/capture', { url: 'https://b.com/2', title: 'B', html: HTML });

  const del = await api.del('/api/queue/q1');
  assert.equal(del.status, 200);
  assert.equal(del.json.removed, 'q1');
  assert.equal(del.json.count, 1);

  const { json } = await api.get('/api/queue');
  assert.deepEqual(json.items.map((i) => i.id), ['q2']);

  const missing = await api.del('/api/queue/nope');
  assert.equal(missing.status, 404);
});

test('queue: wake is emit-only — never broadcast to browsers over WS', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/capture', { url: 'https://a.com/1', title: 'A', html: HTML });

  const WebSocket = require('ws');
  const frames = [];
  const sock = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise((resolve) => sock.on('open', resolve));
  sock.on('message', (raw) => { try { frames.push(JSON.parse(raw)); } catch {} });

  await api.post('/api/queue/push', {});
  await new Promise((r) => setTimeout(r, 80));
  sock.close();

  // C4: ONE batched queue-remove frame for the whole flush (not per-item).
  const removeFrames = frames.filter((f) => f.type === 'queue' && f.op === 'remove');
  assert.equal(removeFrames.length, 1, 'exactly one batched queue-remove frame per flush');
  assert.deepEqual(removeFrames[0].ids, ['q1'], 'the batched frame carries the flushed ids');
  assert.equal(removeFrames[0].reason, 'flushed');
  assert.ok(!frames.some((f) => f.type === 'wake'), 'browsers must never receive a wake frame');
});

// ── integration: draft round-trip ────────────────────────────────────────────

test('queue: survives a restart via draft.json', async (t) => {
  const { api, root, webChatDir, graceful } = await withServer(t);
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });

  await graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(webChatDir, 'draft.json'), 'utf8'));
  assert.equal(draft.queue.length, 1);
  assert.equal(draft.queue[0].id, 'q1');

  const { api: api2 } = await withServer(t, { root });
  const { json } = await api2.get('/api/queue');
  assert.equal(json.count, 1, 'queue restored after reboot');
  assert.equal(json.items[0].id, 'q1');
});

// ── domain unit: the paths HTTP can't reach in commit 2 ──────────────────────

test('queue domain: enqueue assigns q<N> ids and emits add', () => {
  const bus = createBus();
  const state = freshState();
  const events = [];
  bus.subscribe((e) => events.push(e));

  const a = queue.enqueue(state, bus, { kind: 'capture', capture_id: 'cap1', summary: 's' });
  const b = queue.enqueue(state, bus, { kind: 'signal', summary: 't' });
  assert.equal(a.id, 'q1');
  assert.equal(b.id, 'q2');
  assert.equal(state.queue.length, 2);
  const adds = events.filter((e) => e.kind === 'queue' && e.op === 'add');
  assert.equal(adds.length, 2);
});

test('queue domain: emitWake emits one wake with the batch, no ws', () => {
  const bus = createBus();
  const wsFrames = [];
  bus.setBroadcaster((f) => wsFrames.push(f));
  const w = queue.emitWake(bus, [{ id: 'q1', kind: 'signal' }], { reason: 'immediate', source: 'browser' });
  assert.equal(w.kind, 'wake');
  assert.equal(w.reason, 'immediate');
  assert.equal(w.source, 'browser');
  assert.equal(w.batch.length, 1);
  assert.equal(wsFrames.length, 0, 'emitWake emits no WS frame');
});

test('queue domain: remove with revert drops the originating pane', () => {
  const bus = createBus();
  const state = freshState();
  state.mounts.set('m1', { html: '<i>x</i>' });
  const wsFrames = [];
  bus.setBroadcaster((f) => wsFrames.push(f));

  queue.enqueue(state, bus, { kind: 'signal', origin_mount: 'm1', summary: 's' });
  const { removed, reverted } = queue.remove(state, bus, 'q1', { revert: true });
  assert.equal(removed.id, 'q1');
  assert.equal(reverted, true, 'the domain reports the pane was reverted');
  assert.equal(state.mounts.has('m1'), false, 'origin pane dropped');
  assert.ok(wsFrames.some((f) => f.type === 'clear' && f.id === 'm1'));
});

test('queue domain: flush pushes and clears all staged items, returns the batch', () => {
  const bus = createBus();
  const state = freshState();
  queue.enqueue(state, bus, { kind: 'capture', summary: 'a' });
  queue.enqueue(state, bus, { kind: 'signal', summary: 'b' });
  const { batch, wake } = queue.flush(state, bus, {});
  assert.equal(batch.length, 2, 'both staged items pushed');
  assert.equal(state.queue.length, 0);
  assert.equal(wake.kind, 'wake');
});

test('queue domain: flush pushes+clears STAGED only, retains HELD; note rides the wake', () => {
  const bus = createBus();
  const state = freshState();
  queue.enqueue(state, bus, { kind: 'capture', summary: 'a' }); // q1 (staged)
  queue.enqueue(state, bus, { kind: 'signal', summary: 'b' });  // q2
  queue.setStaged(state, bus, 'q2', false);                     // hold q2
  const { batch, wake } = queue.flush(state, bus, { note: 'hi' });
  assert.deepEqual(batch.map((b) => b.id), ['q1'], 'only the staged item is pushed');
  assert.equal(wake.note, 'hi');
  assert.deepEqual(state.queue.map((it) => it.id), ['q2'], 'the held item stays in the queue');
});

test('queue domain: flush with everything held is inert — no wake, nothing cleared', () => {
  const bus = createBus();
  const state = freshState();
  queue.enqueue(state, bus, { kind: 'capture', summary: 'a' }); // q1
  queue.enqueue(state, bus, { kind: 'signal', summary: 'b' });  // q2
  queue.setStaged(state, bus, 'q1', false);
  queue.setStaged(state, bus, 'q2', false);
  const { batch, wake } = queue.flush(state, bus, {});
  assert.equal(wake, null, 'no wake when nothing is staged');
  assert.deepEqual(batch, [], 'nothing pushed');
  assert.equal(state.queue.length, 2, 'held items are NOT cleared');
});

test('queue domain: flush on an empty queue is inert', () => {
  const bus = createBus();
  const state = freshState();
  const { wake } = queue.flush(state, bus, {});
  assert.equal(wake, null);
});

test('queue domain: a comment-only flush (empty queue + note) still wakes', () => {
  const bus = createBus();
  const state = freshState();
  const { batch, wake } = queue.flush(state, bus, { note: 'take a look at the totals' });
  assert.ok(wake, 'a note-only push is a deliberate wake');
  assert.equal(wake.note, 'take a look at the totals');
  assert.deepEqual(batch, [], 'no queued items in the batch');
});

test('queue domain: a note with everything held wakes (note-only) and KEEPS the held items', () => {
  const bus = createBus();
  const state = freshState();
  queue.enqueue(state, bus, { kind: 'signal', summary: 'a' }); // q1
  queue.setStaged(state, bus, 'q1', false);                    // held
  const { batch, wake } = queue.flush(state, bus, { note: 'just this comment' });
  assert.ok(wake, 'the note carries the wake');
  assert.deepEqual(batch, [], 'no staged items in the batch');
  assert.equal(state.queue.length, 1, 'the held item stays');
});

test('queue domain: setStaged holds / re-stages an item and emits an update frame', () => {
  const bus = createBus();
  const state = freshState();
  const updates = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.op === 'update') updates.push(e); });
  queue.enqueue(state, bus, { kind: 'signal', summary: 'a' }); // q1
  assert.equal(state.queue[0].staged, true, 'new items are staged by default');
  queue.setStaged(state, bus, 'q1', false);
  assert.equal(state.queue[0].staged, false, 'held');
  assert.equal(updates[0].staged, false);
  queue.setStaged(state, bus, 'q1', true);
  assert.equal(state.queue[0].staged, true, 're-staged');
});

test('queue domain: reverting a COMMENT item deletes its pin (not a pane)', () => {
  const bus = createBus();
  const state = freshState();
  state.comments = [{ id: 'c1', text: 'note', shared: true, anchor: { mount: 'm1' } }];
  const deletes = [];
  bus.subscribe((e) => { if (e.kind === 'comment' && e.op === 'delete') deletes.push(e); });
  queue.enqueue(state, bus, { kind: 'comment', comment_id: 'c1', origin_mount: 'm1', summary: 'note' }); // q1
  queue.remove(state, bus, 'q1', { revert: true });
  assert.equal(state.queue.length, 0, 'the queue item is removed');
  assert.equal(state.comments.length, 0, 'the pin was deleted — marker gone');
  assert.equal(deletes.length, 1, 'a comment delete frame was emitted');
});

test('queue domain: removeByComment drops every item for a pin; idempotent, leaves others', () => {
  const bus = createBus();
  const state = freshState();
  const removes = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.op === 'remove') removes.push(e.id); });
  queue.enqueue(state, bus, { kind: 'comment', comment_id: 'c1', summary: 'a' }); // q1
  queue.enqueue(state, bus, { kind: 'signal', summary: 'keep' });                  // q2
  queue.enqueue(state, bus, { kind: 'comment', comment_id: 'c1', summary: 'a2' }); // q3 (same pin)

  assert.equal(queue.removeByComment(state, bus, 'c1'), 2, 'both c1 items dropped');
  assert.deepEqual(state.queue.map((it) => it.id), ['q2'], 'the unrelated signal survives');
  assert.deepEqual(removes, ['q1', 'q3']);
  assert.equal(queue.removeByComment(state, bus, 'c1'), 0, 'idempotent — nothing left to drop');
  assert.equal(queue.removeByComment(state, bus, null), 0, 'a null id is a no-op');
});

test('queue domain: a blank/whitespace note with an empty queue stays inert', () => {
  const bus = createBus();
  const state = freshState();
  const { wake } = queue.flush(state, bus, { note: '   ' });
  assert.equal(wake, null, 'whitespace is not a comment');
});

test('queue domain: the queue is capped — oldest drop out', () => {
  const bus = createBus();
  const state = freshState();
  const removes = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.op === 'remove' && e.reason === 'dropped') removes.push(e.id); });
  for (let i = 0; i < queue.MAX_QUEUE + 3; i++) queue.enqueue(state, bus, { kind: 'signal', summary: `s${i}` });
  assert.equal(state.queue.length, queue.MAX_QUEUE, 'queue length capped at MAX_QUEUE');
  assert.deepEqual(removes, ['q1', 'q2', 'q3'], 'the 3 oldest were dropped with remove frames');
  assert.equal(state.queue[0].id, 'q4', 'oldest surviving is q4');
});

// ── review-fix regressions ───────────────────────────────

test('queue: the ADD event stays immutable after a later hold (F7 — no ring rewrite)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/capture', { url: 'https://a.com/1', title: 'A', html: HTML }); // q1, staged
  await api.patch('/api/queue/q1', { staged: false }); // hold — mutates the LIVE item
  const ev = await api.get('/api/events');
  const add = ev.json.events.find((e) => e.kind === 'queue' && e.op === 'add' && e.id === 'q1');
  assert.ok(add, 'the ADD event is retained in the ring');
  assert.equal(add.item.staged, true, 'the served ADD event still shows staged as-enqueued, not the later hold');
});

test('queue: DELETE ?revert=1 reports the domain OUTCOME, not the request flag (B1)', async (t) => {
  const { api } = await withServer(t);
  // A shared pin enqueues a comment item whose Revert deletes the pin → reverted true.
  await api.post('/api/comments', { text: 'look', shared: true, anchor: { mount: 'p1', text: 'x' } });
  const q1 = (await api.get('/api/queue')).json.items.find((it) => it.kind === 'comment');
  assert.ok(q1, 'the shared pin enqueued a comment item');
  const del1 = await api.del('/api/queue/' + q1.id + '?revert=1');
  assert.equal(del1.json.reverted, true, 'the pin existed — Revert dropped it');

  // A capture item has no revertable artifact (origin_mount null) → reverted false
  // even though revert=1 was requested: the route reports the domain truth (B1).
  await api.post('/api/capture', { url: 'https://a.com/1', title: 'A', html: HTML });
  const q2 = (await api.get('/api/queue')).json.items.find((it) => it.kind === 'capture');
  const del2 = await api.del('/api/queue/' + q2.id + '?revert=1');
  assert.equal(del2.json.reverted, false, 'nothing to revert — reported false despite revert=1');
});

test('queue: GET /api/queue/policy carries the server-sent activation hint (B8)', async (t) => {
  const { api } = await withServer(t);
  const { json } = await api.get('/api/queue/policy');
  assert.equal(typeof json.channel_connected, 'boolean');
  assert.ok(json.activation_hint, 'the rail notice text rides the policy response');
  assert.ok(json.activation_hint.title, 'has a title');
  assert.ok(json.activation_hint.body, 'has a body');
  assert.match(json.activation_hint.command, /WEB_CHAT_CHANNEL=1/, 'carries the launch incantation');
});

test('queue: editing a queued shared pin refreshes its summary + emits update, no re-enqueue (F9)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: '<p>plan</p>' });
  // A shared pin enqueues a comment item quoting the original text.
  const p = (await api.post('/api/comments', { text: 'totals look off', shared: true, anchor: { mount: 'm1', text: 'plan' } })).json.pin;
  const before = (await api.get('/api/queue')).json.items.find((it) => it.comment_id === p.id);
  assert.ok(before, 'the shared pin enqueued a comment item');
  assert.match(before.summary, /totals look off/);

  // Edit the pin's text — it stays shared (no privacy flip). The queued summary must
  // refresh so the wake line never quotes the pre-edit (retracted) text.
  await api.patch('/api/comments/' + p.id, { text: 'actually the header is wrong' });

  const q = (await api.get('/api/queue')).json;
  assert.equal(q.count, 1, 'refresh does not enqueue a second item');
  const after = q.items.find((it) => it.comment_id === p.id);
  assert.ok(after, 'the item is still queued (refresh, not dequeue)');
  assert.match(after.summary, /header is wrong/, 'the summary was rebuilt from the new text');
  assert.doesNotMatch(after.summary, /totals look off/, 'the stale text is gone');

  // ...and a queue update event carrying the rebuilt item was emitted.
  const upd = (await api.get('/api/events')).json.events
    .filter((e) => e.kind === 'queue' && e.op === 'update' && e.id === before.id).pop();
  assert.ok(upd, 'a queue update event was emitted');
  assert.match(upd.item.summary, /header is wrong/);
});

test('queue domain: refreshComment is a no-op when the pin was never queued (F9)', () => {
  const bus = createBus();
  const state = freshState();
  const events = [];
  bus.subscribe((e) => events.push(e));
  assert.equal(queue.refreshComment(state, bus, 'c9', { summary: 's', why_wake: 'w' }), 0, 'nothing queued for c9');
  assert.equal(events.length, 0, 'no update emitted for an unqueued pin');
});

test('queue domain: overflow eviction skips HELD items, evicting staged first (B3)', () => {
  const bus = createBus();
  const state = freshState();
  const removed = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.op === 'remove') removed.push({ id: e.ids[0], reason: e.reason }); });
  for (let i = 0; i < queue.MAX_QUEUE; i++) queue.enqueue(state, bus, { kind: 'signal', summary: `s${i}` });
  queue.setStaged(state, bus, 'q1', false); // hold the OLDEST
  queue.enqueue(state, bus, { kind: 'signal', summary: 'overflow' }); // +1 over the cap
  assert.equal(state.queue.length, queue.MAX_QUEUE);
  assert.ok(state.queue.some((it) => it.id === 'q1'), 'the held item survives the overflow');
  assert.ok(!state.queue.some((it) => it.id === 'q2'), 'the oldest STAGED item was evicted instead');
  const evict = removed.find((r) => r.id === 'q2');
  assert.ok(evict && evict.reason === 'dropped', 'a staged eviction carries reason:dropped');
});

test('queue domain: a forced HELD eviction carries a distinct reason (B3)', () => {
  const bus = createBus();
  const state = freshState();
  // Simulate a restored draft already OVER the cap and entirely held — the only way
  // a held item is evicted (enqueue skips held while ANY staged item exists).
  for (let i = 0; i < queue.MAX_QUEUE + 2; i++) state.queue.push({ id: `h${i}`, staged: false, enqueued_at: i });
  state.queueSeq = queue.MAX_QUEUE + 2;
  const removed = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.op === 'remove') removed.push(e.reason); });
  queue.enqueue(state, bus, { kind: 'signal', summary: 'x' }); // +1 staged → 3 over the cap
  assert.equal(state.queue.length, queue.MAX_QUEUE);
  assert.ok(removed.includes('dropped'), 'the staged victim is evicted first');
  assert.ok(removed.includes('evicted-held'), 'a forced held eviction is flagged distinctly');
});

test('queue domain: flush emits ONE batched remove frame with all ids (C4)', () => {
  const bus = createBus();
  const state = freshState();
  const removes = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.op === 'remove') removes.push(e); });
  queue.enqueue(state, bus, { kind: 'capture', summary: 'a' }); // q1
  queue.enqueue(state, bus, { kind: 'signal', summary: 'b' });  // q2
  queue.flush(state, bus, {});
  assert.equal(removes.length, 1, 'one batched remove event for the whole flush');
  assert.deepEqual(removes[0].ids, ['q1', 'q2']);
  assert.equal(removes[0].reason, 'flushed');
});

test('queue domain: Revert no-ops on a same-id re-rendered pane (new gen) — B6', () => {
  const bus = createBus();
  const state = freshState();
  state.mounts.set('m1', { html: 'a', gen: 0 });
  const it = queue.enqueue(state, bus, { kind: 'signal', origin_mount: 'm1', summary: 's' });
  assert.equal(it.origin_gen, 0, 'enqueue stamped the pane gen it saw at enqueue time');
  state.mounts.set('m1', { html: 'b', gen: 1 }); // a stable-id re-render bumps the gen
  const { reverted } = queue.remove(state, bus, it.id, { revert: true });
  assert.equal(reverted, false, 'the stamped gen no longer matches — Revert is a no-op');
  assert.ok(state.mounts.has('m1'), 'the fresh pane is NOT deleted');
});

test('queue domain: Revert deletes the pane when the gen still matches — B6', () => {
  const bus = createBus();
  const state = freshState();
  state.mounts.set('m1', { html: 'a', gen: 0 });
  const it = queue.enqueue(state, bus, { kind: 'signal', origin_mount: 'm1', summary: 's' });
  const { reverted } = queue.remove(state, bus, it.id, { revert: true });
  assert.equal(reverted, true);
  assert.equal(state.mounts.has('m1'), false, 'a same-gen pane is dropped');
});

test('queue domain: a comment Revert falls back to the pane when the pin is gone (F5/C1)', () => {
  const bus = createBus();
  const state = freshState();
  state.comments = []; // the pin was stranded by navigation — already gone
  state.mounts.set('m1', { html: 'x', gen: 0 });
  queue.enqueue(state, bus, { kind: 'comment', comment_id: 'c1', origin_mount: 'm1', summary: 'note' }); // q1
  const { reverted } = queue.remove(state, bus, 'q1', { revert: true });
  assert.equal(reverted, true, 'the fall-through dropped the origin pane');
  assert.equal(state.mounts.has('m1'), false, 'the stranded comment item still reverted something');
});

// ── parked delivery (Push with no channel connected) ─────────────────────────

test('queue domain: flush with NO channel connected PARKS instead of waking', () => {
  const bus = createBus();
  const state = freshState();
  state.wakeConsumers = 0; // no channel
  const events = [];
  bus.subscribe((e) => events.push(e));
  queue.enqueue(state, bus, { kind: 'capture', capture_id: 'cap1', summary: 'a' }); // q1
  queue.enqueue(state, bus, { kind: 'signal', summary: 'b' });                       // q2

  const { batch, wake, parked } = queue.flush(state, bus, { note: 'ctx' });
  assert.equal(wake, null, 'no consumerless wake emitted');
  assert.ok(parked, 'the batch is parked');
  assert.equal(batch.length, 2);
  assert.equal(state.queue.length, 0, 'the staged items still clear — they are IN the park');
  assert.ok(state.pendingWake, 'a pending wake is stored');
  assert.equal(state.pendingWake.batch.length, 2);
  assert.equal(state.pendingWake.note, 'ctx');
  // The park carries the summary envelope (bodies fetched by tool call, never inlined).
  assert.ok(state.pendingWake.envelope.content.includes('ctx'));
  // The flush emitted the batched remove frame but NO wake event.
  assert.equal(events.filter((e) => e.kind === 'wake').length, 0, 'no wake on the bus');
  assert.ok(events.some((e) => e.kind === 'queue' && e.op === 'remove' && e.reason === 'flushed'));
});

test('queue domain: a re-push while parked MERGES into a single park, re-stamping the id', () => {
  const bus = createBus();
  const state = freshState();
  state.wakeConsumers = 0;
  queue.enqueue(state, bus, { kind: 'capture', capture_id: 'cap1', summary: 'first' });
  const p1 = queue.flush(state, bus, { note: 'one' }).parked;

  queue.enqueue(state, bus, { kind: 'signal', summary: 'second' });
  const p2 = queue.flush(state, bus, { note: 'two' }).parked;

  assert.notEqual(p2.id, p1.id, 're-parking re-stamps the id (a stale consume can not clear the merged park)');
  assert.equal(state.pendingWake.id, p2.id, 'there is exactly ONE park');
  assert.equal(state.pendingWake.batch.length, 2, 'both batches merged');
  assert.deepEqual(state.pendingWake.batch.map((it) => it.summary), ['first', 'second']);
  assert.equal(state.pendingWake.note, 'two', 'the latest note re-stamps');
  const c = state.pendingWake.envelope.content;
  assert.ok(c.includes('first') && c.includes('second'), 'the rebuilt envelope covers both');
});

test('queue domain: the merged park is capped at MAX_QUEUE — repeated re-pushes stay bounded (park backstop)', () => {
  const state = freshState();
  state.wakeConsumers = 0;
  const mk = (tag) => Array.from({ length: queue.MAX_QUEUE }, (_, i) => ({ id: `${tag}${i}`, kind: 'signal', summary: `${tag}${i}` }));
  // Three near-cap re-pushes: without a backstop the merged park would hold ~3×MAX_QUEUE
  // (and ride draft.json + the injected envelope) without bound.
  queue.parkWake(state, { batch: mk('a'), reason: 'push', source: 'queue' });
  queue.parkWake(state, { batch: mk('b'), reason: 'push', source: 'queue' });
  queue.parkWake(state, { batch: mk('c'), reason: 'push', source: 'queue' });
  assert.equal(state.pendingWake.batch.length, queue.MAX_QUEUE, 'the merged park is capped at MAX_QUEUE, not 3×');
  assert.ok(state.pendingWake.batch.every((it) => it.id.startsWith('c')), 'the newest batch survives; older overflow is evicted');
});

test('queue domain: a note-less re-push keeps the parked note', () => {
  const bus = createBus();
  const state = freshState();
  state.wakeConsumers = 0;
  queue.enqueue(state, bus, { kind: 'signal', summary: 'a' });
  queue.flush(state, bus, { note: 'keep me' });
  queue.enqueue(state, bus, { kind: 'signal', summary: 'b' });
  queue.flush(state, bus, {}); // no note
  assert.equal(state.pendingWake.note, 'keep me', 'a note-less re-push preserves the parked note');
});

test('queue domain: drainPending delivers the park as one wake, exactly once', () => {
  const bus = createBus();
  const state = freshState();
  state.wakeConsumers = 0;
  queue.enqueue(state, bus, { kind: 'capture', capture_id: 'cap1', summary: 'a' });
  queue.flush(state, bus, { note: 'ctx' });
  assert.ok(state.pendingWake);

  const wakes = [];
  bus.subscribe((e) => { if (e.kind === 'wake') wakes.push(e); });
  const w = queue.drainPending(state, bus);
  assert.ok(w, 'the drain returns the emitted wake');
  assert.equal(w.kind, 'wake');
  assert.equal(w.batch.length, 1);
  assert.equal(w.note, 'ctx');
  assert.equal(wakes.length, 1, 'exactly one wake emitted');
  assert.equal(state.pendingWake, null, 'the park is cleared');
  assert.equal(queue.drainPending(state, bus), null, 'a second drain finds nothing');
  assert.equal(wakes.length, 1, 'no second wake');
});

test('queue domain: consumePending is id-checked', () => {
  const bus = createBus();
  const state = freshState();
  state.wakeConsumers = 0;
  queue.enqueue(state, bus, { kind: 'signal', summary: 'a' });
  const park = queue.flush(state, bus, {}).parked;

  assert.equal(queue.consumePending(state, 'pw-nope'), false, 'a stale id does not clear the park');
  assert.ok(state.pendingWake, 'the park survives a stale consume');
  assert.equal(queue.consumePending(state, park.id), true, 'the matching id clears it');
  assert.equal(state.pendingWake, null);
  assert.equal(queue.consumePending(state, park.id), false, 'nothing left to consume');
});

// ── integration: parked delivery over HTTP ───────────────────────────────────

test('queue: Push with no channel connected PARKS the batch', async (t) => {
  const { api } = await withServer(t); // no wake-consumer → disconnected
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  assert.equal((await api.get('/api/queue')).json.count, 1);

  const push = await api.post('/api/queue/push', {});
  assert.equal(push.json.ok, true, 'a park stays ok:true so the client clears its rows (F6 contract)');
  assert.equal(push.json.pushed, 1);
  assert.equal(push.json.mode, 'parked');

  assert.equal((await api.get('/api/queue')).json.count, 0, 'the staged item cleared into the park');
  const ev = await api.get('/api/events');
  assert.equal(ev.json.events.filter((e) => e.kind === 'wake').length, 0, 'no consumerless wake in the ring');

  const pending = await api.get('/api/queue/pending');
  assert.ok(pending.json.pending, 'a park is pending for the hook (path A)');
  assert.equal(pending.json.pending.id, push.json.pending_id);
  assert.match(pending.json.pending.envelope.content, /example\.com/);
});

test('queue: re-push MERGES into one park; consume is id-checked', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/capture', { url: 'https://a.com/1', title: 'A', html: HTML });
  const id1 = (await api.post('/api/queue/push', {})).json.pending_id;

  await api.post('/api/capture', { url: 'https://b.com/2', title: 'B', html: HTML });
  const id2 = (await api.post('/api/queue/push', {})).json.pending_id;
  assert.notEqual(id2, id1, 're-parking re-stamps the id (never two parks)');

  const pending = await api.get('/api/queue/pending');
  assert.equal(pending.json.pending.id, id2, 'a single merged park');
  const content = pending.json.pending.envelope.content;
  assert.match(content, /a\.com/);
  assert.match(content, /b\.com/, 'both batches merged into one envelope');

  const stale = await api.post('/api/queue/pending/consume', { id: id1 });
  assert.equal(stale.json.consumed, false, 'a stale id can not clear the merged park');
  assert.ok((await api.get('/api/queue/pending')).json.pending, 'the park survives a stale consume');
  const good = await api.post('/api/queue/pending/consume', { id: id2 });
  assert.equal(good.json.consumed, true);
  assert.equal((await api.get('/api/queue/pending')).json.pending, null, 'the park is cleared');
});

test('queue: a connecting wake-consumer drains a parked wake exactly once', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  assert.equal((await api.post('/api/queue/push', {})).json.mode, 'parked', 'no channel → parked');

  const wakes = [];
  const h = subscribeSSE({ port, kinds: ['wake'], onEvent: (e) => { if (e.kind === 'wake') wakes.push(e); } });
  t.after(() => h.close());

  await waitUntil(() => wakes.length >= 1);
  await settle(60); // give any (erroneous) second wake a chance to arrive
  assert.equal(wakes.length, 1, 'the park drains into exactly one wake');
  assert.equal(wakes[0].batch.length, 1);
  assert.equal(wakes[0].batch[0].capture_id, 'cap1');
  assert.equal((await api.get('/api/queue/pending')).json.pending, null, 'the park cleared on drain');
});

test('queue: a Push while connected WAKES and never parks', async (t) => {
  const { api, port } = await withServer(t);
  const ch = await connectChannel(api, port);
  t.after(() => ch.close());
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  const push = await api.post('/api/queue/push', {});
  assert.equal(push.json.mode, 'wake');
  assert.ok(push.json.seq > 0);
  assert.equal((await api.get('/api/queue/pending')).json.pending, null, 'nothing parked when connected');
});

test('queue: a parked wake rides the draft snapshot round-trip', async (t) => {
  const { api, root, webChatDir, graceful } = await withServer(t);
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  const id = (await api.post('/api/queue/push', {})).json.pending_id;
  assert.ok(id, 'the push parked');

  await graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(webChatDir, 'draft.json'), 'utf8'));
  assert.ok(draft.pendingWake, 'the park is persisted in the draft');
  assert.equal(draft.pendingWake.id, id);

  const { api: api2 } = await withServer(t, { root });
  const pending = await api2.get('/api/queue/pending');
  assert.ok(pending.json.pending, 'the park is restored after reboot');
  assert.equal(pending.json.pending.id, id);
  assert.match(pending.json.pending.envelope.content, /example\.com/);
});

// The queue's element groups (annotation engine tranche 3, U423; PLAN.md
// 3B.2; DECISIONS.md D2 "marks coalesce one item per (type, mount)", K.2-10).
//
// Every element type's raise folds into ONE queue item per (type, origin
// pane) — the comment and the chat family included — unless the type
// declares `coalesce: 'none'` (then one item per element, as before groups).
// A group is keyed, dequeued and refreshed by element id from inside: a
// removed element leaves its group with one update frame, the last member's
// leaving removes the item with one remove frame, and a group whose newest
// member left reads `<label> ×N`. A held group still merges and stays held;
// MAX_QUEUE evicts a group as one item.
//
// Here through the queue domain alone (lib/server/domain/queue) over the
// policy's own items (lib/channel/policy classify), the way the daemon's
// subscriber dispatches them.

const test = require('node:test');
const assert = require('node:assert');

const { createBus } = require('../lib/core/bus');
const { classify, mergeElement, membersOf } = require('../lib/channel/policy');
const queue = require('../lib/server/domain/queue');

const MOUNTS = ['m1', 'm2', 'm3'];
function freshState() {
  return {
    queue: [], queueSeq: 0, mounts: new Map(MOUNTS.map((id) => [id, { id, gen: 0 }])), markdown: new Map(), store: {},
    signals: {}, wakeConsumers: 0, wakeConsumerSeenAt: 0, pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}
// The daemon's dispatch (lib/server/index.js) for an element raise.
function dispatch(state, bus, c, label) {
  if (!c) return;
  if (c.action === 'dequeue') queue.removeByElement(state, bus, c.element_id);
  else if (c.action === 'refresh') queue.refreshElement(state, bus, c.element_id, c.item);
  else if (c.action === 'enqueue') queue.enqueueElement(state, bus, label ? { ...c.item, label } : c.item);
}
const DECLS = {
  comment: { wake: { coalesce: 'count', respond: true }, label: 'Comment' },
  highlight: { wake: true, label: 'Highlight' },
  sticker: { wake: { coalesce: 'none' }, label: 'Sticker' },
};
const pinEvent = (id, mount, text, op = 'add') => ({ kind: 'comment', op, pin: { id, seq: 1, shared: true, text, anchor: { mount } } });
const elEvent = (type, id, mount, op = 'add', extra = {}) => ({ kind: 'element', type, op, id, v: 1, shared: true, mount, ...extra });
function raise(state, bus, event) {
  const type = event.kind === 'comment' ? 'comment' : event.type;
  dispatch(state, bus, classify(event, { elementTypes: { [type]: DECLS[type] } }), DECLS[type].label);
}
test('20 shared comments on one pane → one item of count 20, element_ids in order, the newest\'s summary; one add frame then 19 update frames', () => {
  const state = freshState();
  const bus = createBus();
  const ops = [];
  bus.subscribe((e) => { if (e.kind === 'queue') ops.push(e.op); });
  const ids = Array.from({ length: 20 }, (_, i) => `c${i + 1}`);
  ids.forEach((id, i) => raise(state, bus, pinEvent(id, 'm1', `note ${i + 1}`)));
  assert.equal(state.queue.length, 1, 'one item');
  const [g] = state.queue;
  assert.equal(g.kind, 'element');
  assert.equal(g.type, 'comment');
  assert.equal(g.count, 20);
  assert.deepEqual(g.element_ids, ids, 'oldest → newest');
  assert.equal(g.element_id, 'c20', 'the newest');
  assert.equal(g.summary, 'm1 · "note 20"', 'the newest\'s summary');
  assert.equal(g.why_wake, 'comment pinned for Claude');
  assert.equal(g.respond, true);
  assert.equal(g.origin_mount, 'm1');
  assert.ok(!('comment_id' in g), 'no comment_id on a new item');
  assert.deepEqual(ops, ['add', ...Array(19).fill('update')], 'one add frame, then one update frame per member');
});

test('two types on one mount → two items; one type on two mounts → two items; a coalesce \'none\' type → one item per element', () => {
  const state = freshState();
  const bus = createBus();
  raise(state, bus, pinEvent('c1', 'm1', 'a'));
  raise(state, bus, elEvent('highlight', 'h1', 'm1'));
  raise(state, bus, pinEvent('c2', 'm1', 'b'));
  raise(state, bus, elEvent('highlight', 'h2', 'm1'));
  raise(state, bus, elEvent('highlight', 'h3', 'm2'));
  assert.deepEqual(state.queue.map((it) => [it.type, it.origin_mount, it.element_ids]), [
    ['comment', 'm1', ['c1', 'c2']],
    ['highlight', 'm1', ['h1', 'h2']],
    ['highlight', 'm2', ['h3']],
  ]);
  const none = freshState();
  raise(none, bus, elEvent('sticker', 's1', 'm1'));
  raise(none, bus, elEvent('sticker', 's2', 'm1'));
  raise(none, bus, elEvent('sticker', 's1', 'm1', 'edit', { v: 2 }));
  assert.deepEqual(none.queue.map((it) => [it.element_id, it.count, it.coalesce]), [['s1', 1, 'none'], ['s2', 1, 'none']], 'today\'s behaviour: one item per element');
  assert.equal(none.queue[0].v, 2, 'a refresh reaches its own item');
});

test('a chat pin (no pane) groups per type: every queued chat-comment rides one item (RULED U423@chat-group-key Q9 = a)', () => {
  const state = freshState();
  const bus = createBus();
  const chat = { wake: { coalesce: 'count', respond: true }, label: 'Comment', where: 'on turn 3\'s reply', text: 'x' };
  for (const id of ['k1', 'k2', 'k3']) {
    const c = classify(elEvent('chat-comment', id, null), { elementTypes: { 'chat-comment': chat } });
    queue.enqueueElement(state, bus, c.item);
  }
  assert.deepEqual(state.queue.map((it) => [it.type, it.origin_mount, it.element_ids]), [['chat-comment', null, ['k1', 'k2', 'k3']]]);
});

test('a removed element leaves its group (one update frame, count − 1); the newest\'s leaving gives `<label> ×N`; the last member\'s leaving removes the item (one remove frame)', () => {
  const state = freshState();
  const bus = createBus();
  for (const id of ['h1', 'h2', 'h3']) raise(state, bus, elEvent('highlight', id, 'm1'));
  const [g] = state.queue;
  assert.equal(g.summary, 'Highlight · h3@1');
  const ops = [];
  bus.subscribe((e) => { if (e.kind === 'queue') ops.push([e.op, e.id, e.item ? e.item.count : null]); });
  raise(state, bus, elEvent('highlight', 'h1', 'm1', 'delete'));
  assert.deepEqual(ops, [['update', g.id, 2]]);
  assert.deepEqual(g.element_ids, ['h2', 'h3']);
  assert.equal(g.summary, 'Highlight · h3@1', 'an older member\'s leaving keeps the newest\'s words');
  raise(state, bus, elEvent('highlight', 'h3', 'm1', 'edit', { shared: false }));
  assert.deepEqual(ops.at(-1), ['update', g.id, 1]);
  assert.equal(g.summary, 'Highlight ×1', 'the newest left: `<label> ×N`');
  assert.equal(g.element_id, 'h2');
  assert.ok(!('v' in g), 'the newest\'s version went with it');
  raise(state, bus, elEvent('highlight', 'h4', 'm1'));
  assert.equal(g.summary, 'Highlight · h4@1', 'until the next raise');
  raise(state, bus, elEvent('highlight', 'h2', 'm1', 'delete'));
  raise(state, bus, elEvent('highlight', 'h4', 'm1', 'delete'));
  assert.deepEqual(ops.slice(-2), [['update', g.id, 1], ['remove', g.id, null]], 'the last member removes the item, through remove');
  assert.deepEqual(state.queue, []);
  assert.equal(queue.removeByElement(state, bus, 'h4'), 0, 'idempotent');
});

test('a member raised again is refreshed in place and becomes the newest (a user reply on a queued pin stacks nothing)', () => {
  const state = freshState();
  const bus = createBus();
  raise(state, bus, pinEvent('c1', 'm1', 'first'));
  raise(state, bus, pinEvent('c2', 'm1', 'second'));
  const reply = { kind: 'comment', op: 'reply', author: 'user', pin: { id: 'c1', seq: 2, shared: true, text: 'first', anchor: { mount: 'm1' }, replies: [{ author: 'user', text: 'and more' }] } };
  raise(state, bus, reply);
  assert.equal(state.queue.length, 1);
  assert.deepEqual(state.queue[0].element_ids, ['c2', 'c1']);
  assert.equal(state.queue[0].count, 2);
  assert.equal(state.queue[0].summary, 'm1 · "and more"');
  assert.equal(state.queue[0].why_wake, 'comment reply');
});

test('a held group still merges and stays held', () => {
  const state = freshState();
  const bus = createBus();
  raise(state, bus, elEvent('highlight', 'h1', 'm1'));
  queue.setStaged(state, bus, state.queue[0].id, false);
  raise(state, bus, elEvent('highlight', 'h2', 'm1'));
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].staged, false, 'still held');
  assert.deepEqual(state.queue[0].element_ids, ['h1', 'h2']);
  const out = queue.flush(state, bus, {});
  assert.deepEqual(out.batch, [], 'a held group stays for a later Push');
  assert.equal(state.queue.length, 1);
});

test('MAX_QUEUE evicts a group as one item', () => {
  const state = freshState();
  const bus = createBus();
  for (const id of ['h1', 'h2', 'h3']) raise(state, bus, elEvent('highlight', id, 'm1'));
  const group = state.queue[0];
  for (let i = 0; i < queue.MAX_QUEUE - 1; i++) queue.enqueue(state, bus, { kind: 'signal', summary: `s${i}` });
  assert.equal(state.queue.length, queue.MAX_QUEUE);
  const removes = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.op === 'remove') removes.push(e.ids); });
  queue.enqueue(state, bus, { kind: 'signal', summary: 'one more' });
  assert.deepEqual(removes, [[group.id]], 'the oldest staged item — the whole group — goes as one');
  assert.ok(!state.queue.some((it) => it.kind === 'element'));
});

test('a group\'s excerpts: one member\'s is its string; more members are [{id, text}] in member order; a leaving member takes its entry', () => {
  const state = freshState();
  const bus = createBus();
  const withEx = (id, text) => ({ ...classify(elEvent('highlight', id, 'm1'), { elementTypes: { highlight: DECLS.highlight } }).item, excerpt: text });
  queue.enqueueElement(state, bus, withEx('h1', 'one'));
  assert.equal(state.queue[0].excerpt, 'one');
  queue.enqueueElement(state, bus, withEx('h2', 'two'));
  queue.enqueueElement(state, bus, { ...withEx('h3', 'x'), excerpt: undefined });
  assert.deepEqual(state.queue[0].excerpt, [{ id: 'h1', text: 'one' }, { id: 'h2', text: 'two' }]);
  queue.refreshElement(state, bus, 'h1', withEx('h1', 'one, edited'));
  assert.deepEqual(state.queue[0].excerpt, [{ id: 'h1', text: 'one, edited' }, { id: 'h2', text: 'two' }]);
  queue.removeByElement(state, bus, 'h2');
  assert.deepEqual(state.queue[0].excerpt, [{ id: 'h1', text: 'one, edited' }]);
  assert.deepEqual(state.queue[0].element_ids, ['h1', 'h3']);
});

test('the update frame carries a copy: a later fold never rewrites a served frame (F7)', () => {
  const state = freshState();
  const bus = createBus();
  const seen = [];
  bus.subscribe((e) => { if (e.kind === 'queue' && e.item) seen.push(e.item); });
  raise(state, bus, elEvent('highlight', 'h1', 'm1'));
  raise(state, bus, elEvent('highlight', 'h2', 'm1'));
  raise(state, bus, elEvent('highlight', 'h3', 'm1'));
  assert.deepEqual(seen.map((it) => it.element_ids), [['h1'], ['h1', 'h2'], ['h1', 'h2', 'h3']]);
});

test('mergeElement is pure data over two items; membersOf reads a group or a pre-group element item', () => {
  const g = { kind: 'element', type: 'highlight', element_id: 'h1', v: 1, summary: 'a', why_wake: 'w', label: 'Highlight' };
  assert.deepEqual(membersOf(g), ['h1'], 'a pre-group element item (an older draft) is a group of one');
  mergeElement(g, { kind: 'element', type: 'highlight', element_id: 'h2', v: 3, summary: 'b', why_wake: 'w2', image: { state: 'ready' } });
  assert.deepEqual([g.element_ids, g.count, g.element_id, g.v, g.summary, g.why_wake, g.image], [['h1', 'h2'], 2, 'h2', 3, 'b', 'w2', { state: 'ready' }]);
  mergeElement(g, { kind: 'element', type: 'highlight', element_id: 'h1', v: 2, summary: 'c', why_wake: 'w3' });
  assert.deepEqual([g.element_ids, g.element_id, g.v, g.summary, 'image' in g], [['h2', 'h1'], 'h1', 2, 'c', false], 'the newest\'s picture only');
});

test('re-send raises a kept delivered group\'s members that still exist; a group none of whose members exists is gone', () => {
  const state = freshState();
  const bus = createBus();
  for (const id of ['h1', 'h2', 'h3']) raise(state, bus, elEvent('highlight', id, 'm1'));
  const kept = state.queue[0].id;
  queue.flush(state, bus, {});
  assert.deepEqual(state.queue, []);
  const r = queue.resendElement(state, bus, kept, { exists: (id) => id !== 'h3' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.item.element_ids, ['h1', 'h2']);
  assert.equal(r.item.summary, 'Highlight ×2', 'its newest is gone: the label and count');
  assert.equal(r.item.resent_from, kept);
  queue.flush(state, bus, {});
  assert.equal(queue.resendElement(state, bus, r.item.id, { exists: () => false }).status, 404);
});

test('sendElement\'s "already queued" reads group membership', () => {
  const state = freshState();
  const bus = createBus();
  for (const id of ['h1', 'h2']) raise(state, bus, elEvent('highlight', id, 'm1'));
  const r = queue.sendElement(state, bus, 'h1', elEvent('highlight', 'h1', 'm1', 'send'));
  assert.deepEqual([r.ok, r.already, r.item.id], [true, true, state.queue[0].id]);
  assert.equal(queue.queuedElementItem(state, 'h2').id, state.queue[0].id);
  assert.equal(queue.queuedElementItem(state, 'h9'), null);
});


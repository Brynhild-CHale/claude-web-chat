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


// ── a folded item's describe per group (U633, 5B.3; K.2-251) ─────────────────
// The daemon composes each raise's describe over the stroke group's shared
// members and names them (element_ids); a fold keeps one entry per group. An
// edit (refreshElement), a leaver (removeByElement) and a re-send
// (resendElement) change only the entry whose group the member is in.
{
  const { elementItem } = require('../lib/channel/policy');
  // The daemon's dispatch puts the type's label on the item (dispatch above).
  const stroke = (id, describe, v = 1) => ({ ...elementItem({ kind: 'element', type: 'ink', op: 'add', id, v, shared: true, has: true, mount: 'm1' },
    { wake: true, label: 'Ink', describe }), label: 'Ink' });
  const A = (bbox = [0.1, 0.1, 0.2, 0.2]) => ({ shape: 'circle', confidence: 0.8, count: 2, bbox, element_ids: ['a1', 'a2'] });
  const B = (bbox = [0.5, 0.6, 0.3, 0.05]) => ({ shape: 'underline', confidence: 0.9, count: 1, bbox, element_ids: ['b1'] });
  const keys = (d) => Object.keys(d).sort();
  function twoGroups() {
    const state = freshState();
    const bus = createBus();
    queue.enqueueElement(state, bus, stroke('a1', { ...A(), count: 1, element_ids: ['a1'] }));
    queue.enqueueElement(state, bus, stroke('a2', A()));
    queue.enqueueElement(state, bus, stroke('b1', B()));
    const [it] = state.queue;
    assert.deepStrictEqual(it.describe.groups.map((g) => g.element_ids), [['a1', 'a2'], ['b1']], 'two groups folded');
    return { state, bus, it };
  }

  test('a folded item: the OLDER group\'s member edited → its own entry refreshed in place, the newer entry untouched, groups kept', () => {
    const { state, bus, it } = twoGroups();
    const newer = JSON.stringify(it.describe.groups[1]);
    const summary = it.summary;
    queue.refreshElement(state, bus, 'a1', stroke('a1', A([0.1, 0.3, 0.2, 0.2]), 2));
    assert.deepStrictEqual(it.describe.groups[0].bbox, [0.1, 0.3, 0.2, 0.2], 'the older entry is the edit\'s');
    assert.equal(JSON.stringify(it.describe.groups[1]), newer, 'the newer entry untouched');
    assert.deepStrictEqual(it.describe.groups.map((g) => g.element_ids), [['a1', 'a2'], ['b1']], 'order kept');
    assert.equal(it.describe.count, 3);
    assert.deepStrictEqual(it.describe.bbox, [0.1, 0.3, 0.7, 0.35], 'the top level re-derived');
    assert.equal(it.summary, summary, 'an older member\'s edit keeps the newest\'s words');
  });

  test('a folded item: the newest member edited → only its entry replaced, groups kept', () => {
    const { state, bus, it } = twoGroups();
    const older = JSON.stringify(it.describe.groups[0]);
    queue.refreshElement(state, bus, 'b1', stroke('b1', { ...B([0.5, 0.7, 0.3, 0.05]), shape: 'strike' }, 2));
    assert.equal(it.describe.groups.length, 2, 'the groups never collapse to one');
    assert.equal(JSON.stringify(it.describe.groups[0]), older);
    assert.equal(it.describe.groups[1].shape, 'strike');
    assert.equal(it.describe.shape, 'strike');
    assert.equal(it.v, 2, 'the newest\'s version, as before');
    assert.match(it.summary, /^Ink · strike · 1 stroke · b1@2$/);
  });

  test('an unfolded item\'s newest member refreshed → describe is exactly {shape, confidence, count, bbox}, no element_ids', () => {
    const state = freshState();
    const bus = createBus();
    queue.enqueueElement(state, bus, stroke('a1', { ...A(), count: 1, element_ids: ['a1'] }));
    queue.enqueueElement(state, bus, stroke('a2', A()));
    const [it] = state.queue;
    assert.deepStrictEqual(keys(it.describe), ['bbox', 'confidence', 'count', 'shape']);
    queue.refreshElement(state, bus, 'a2', stroke('a2', A([0.1, 0.2, 0.2, 0.2]), 2));
    assert.deepStrictEqual(keys(it.describe), ['bbox', 'confidence', 'count', 'shape'], 'the four fields alone');
    assert.deepStrictEqual(it.describe.bbox, [0.1, 0.2, 0.2, 0.2]);
    // An older member's edit refreshes it too (no stale extent).
    queue.refreshElement(state, bus, 'a1', stroke('a1', A([0.15, 0.2, 0.2, 0.2]), 2));
    assert.deepStrictEqual(it.describe, { shape: 'circle', confidence: 0.8, count: 2, bbox: [0.15, 0.2, 0.2, 0.2] });
  });

  test('removeByElement of a member of one group in a folded item: that entry gone, the other kept, the top level re-derived', () => {
    const { state, bus, it } = twoGroups();
    const seen = [];
    bus.subscribe((e) => { if (e.kind === 'queue' && e.item) seen.push(e.item); });
    queue.removeByElement(state, bus, 'a2');
    assert.deepStrictEqual(it.element_ids, ['a1', 'b1']);
    assert.deepStrictEqual(it.describe, { shape: 'underline', confidence: 0.9, count: 1, bbox: [0.5, 0.6, 0.3, 0.05] },
      'one entry left: the four fields alone; no count or extent of the leaver\'s group');
    assert.equal(it.summary, 'Ink ×2', 'the summary recomputed');
    assert.deepStrictEqual(seen.at(-1).describe, it.describe, 'the update frame carries it');
    // Three groups, the middle one's member leaves: the other two stay a list.
    const s3 = twoGroups();
    queue.enqueueElement(s3.state, s3.bus, stroke('c1', { shape: 'strike', confidence: 0.6, count: 1, bbox: [0, 0.9, 0.1, 0.05], element_ids: ['c1'] }));
    queue.removeByElement(s3.state, s3.bus, 'b1');
    assert.deepStrictEqual(s3.it.describe.groups.map((g) => g.element_ids), [['a1', 'a2'], ['c1']]);
    assert.equal(s3.it.describe.count, 3);
    assert.deepStrictEqual(s3.it.describe.bbox, [0, 0.1, 0.3, 0.85]);
  });

  test('a re-send of a delivered folded item with one group\'s member gone: that group\'s entry dropped, the other kept, the gone member absent', () => {
    const { state, bus, it } = twoGroups();
    const kept = it.id;
    queue.flush(state, bus, {});
    assert.deepStrictEqual(state.queue, []);
    const r = queue.resendElement(state, bus, kept, { exists: (id) => id !== 'b1' });
    assert.equal(r.ok, true);
    assert.deepStrictEqual(r.item.element_ids, ['a1', 'a2']);
    assert.deepStrictEqual(r.item.describe, { shape: 'circle', confidence: 0.8, count: 2, bbox: [0.1, 0.1, 0.2, 0.2] }, 'the gone member\'s group dropped');
    assert.ok(!JSON.stringify(r.item).includes('b1'), 'the gone member is nowhere on the item');
    assert.ok(!JSON.stringify(r.item.describe).includes('0.65'), 'nor its extent');
    // An older group's member gone instead: the newer group's guess kept.
    const s2 = twoGroups();
    queue.flush(s2.state, s2.bus, {});
    const r2 = queue.resendElement(s2.state, s2.bus, s2.it.id, { exists: (id) => id !== 'a1' });
    assert.deepStrictEqual(r2.item.element_ids, ['a2', 'b1']);
    assert.deepStrictEqual(r2.item.describe, { shape: 'underline', confidence: 0.9, count: 1, bbox: [0.5, 0.6, 0.3, 0.05] });
    // Every member alive: the folded describe re-sent whole.
    const s3 = twoGroups();
    const whole = JSON.stringify(s3.it.describe);
    queue.flush(s3.state, s3.bus, {});
    assert.equal(JSON.stringify(queue.resendElement(s3.state, s3.bus, s3.it.id, { exists: () => true }).item.describe), whole);
  });
}

// ── a refresh after a partial leave, and the summary's shape words (U633b, 5B.3; RULED G6 = a, G7 = a) ──
// A leaver drops its whole group's entry; a held member of that group then
// edited is appended as a fold appends a raise, so every held group's guess
// stays listed. An older member of the NEWEST group edited brings the
// summary's shape words with it; an older group's edit leaves them.
{
  const { elementItem } = require('../lib/channel/policy');
  const stroke = (id, describe, v = 1) => ({ ...elementItem({ kind: 'element', type: 'ink', op: 'add', id, v, shared: true, has: true, mount: 'm1' },
    { wake: true, label: 'Ink', describe }), label: 'Ink' });
  const A = { shape: 'circle', confidence: 0.8, count: 2, bbox: [0.1, 0.1, 0.2, 0.2], element_ids: ['a1', 'a2'] };
  const B = { shape: 'underline', confidence: 0.9, count: 1, bbox: [0.5, 0.6, 0.3, 0.05], element_ids: ['b1'] };
  function twoGroups() {
    const state = freshState();
    const bus = createBus();
    queue.enqueueElement(state, bus, stroke('a1', { ...A, count: 1, element_ids: ['a1'] }));
    queue.enqueueElement(state, bus, stroke('a2', A));
    queue.enqueueElement(state, bus, stroke('b1', B));
    return { state, bus, it: state.queue[0] };
  }

  test('a folded A+B item, a1 leaves, a2 edited → B\'s guess still listed beside A\'s refreshed entry', () => {
    const { state, bus, it } = twoGroups();
    queue.removeByElement(state, bus, 'a1');
    assert.deepStrictEqual(it.describe, { shape: 'underline', confidence: 0.9, count: 1, bbox: [0.5, 0.6, 0.3, 0.05] }, 'A\'s entry went with a1 (U633)');
    const seen = [];
    bus.subscribe((e) => { if (e.kind === 'queue' && e.item) seen.push(e.item); });
    queue.refreshElement(state, bus, 'a2', stroke('a2', { shape: 'check', confidence: 0.7, count: 1, bbox: [0.2, 0.0, 0.1, 0.3], element_ids: ['a2'] }, 2));
    assert.ok(it.describe.groups, 'two guesses: a list');
    assert.deepStrictEqual(it.describe.groups.map((g) => [g.shape, g.element_ids]), [['underline', ['b1']], ['check', ['a2']]], 'B kept, A\'s refreshed entry appended');
    assert.equal(it.describe.count, 2);
    assert.deepStrictEqual(it.describe.bbox, [0.2, 0, 0.6, 0.65]);
    assert.deepStrictEqual(seen.at(-1).describe, it.describe, 'the update frame carries it');
    assert.equal(it.summary, 'Ink ×2', 'the leaver\'s summary has no shape words to follow');
    // A second edit of a2 now meets its own entry: replaced in place, B untouched.
    queue.refreshElement(state, bus, 'a2', stroke('a2', { shape: 'cross', confidence: 0.6, count: 1, bbox: [0.2, 0.0, 0.1, 0.3], element_ids: ['a2'] }, 3));
    assert.deepStrictEqual(it.describe.groups.map((g) => [g.shape, g.element_ids]), [['underline', ['b1']], ['cross', ['a2']]]);
  });

  test('an unfolded two-stroke item: the older member edited → the summary\'s shape words follow the refreshed describe', () => {
    const state = freshState();
    const bus = createBus();
    queue.enqueueElement(state, bus, stroke('a1', { ...A, count: 1, element_ids: ['a1'] }));
    queue.enqueueElement(state, bus, stroke('a2', A));
    const [it] = state.queue;
    assert.equal(it.summary, 'Ink · circle · 2 strokes · a2@1');
    queue.refreshElement(state, bus, 'a1', stroke('a1', { ...A, shape: 'cross' }, 2));
    assert.equal(it.describe.shape, 'cross');
    assert.equal(it.summary, 'Ink · cross · 2 strokes · a2@1', 'the line and describe.shape agree; v and the id part kept');
    assert.equal(it.v, 1, 'the newest\'s version kept');
    assert.equal(it.element_id, 'a2');
  });

  test('a folded item: an older GROUP\'s member edited → the summary is the newest raise\'s words, unchanged', () => {
    const { state, bus, it } = twoGroups();
    const { summary, why_wake } = it;
    assert.equal(summary, 'Ink · underline · 1 stroke · b1@1');
    queue.refreshElement(state, bus, 'a1', stroke('a1', { ...A, shape: 'cross' }, 2));
    assert.equal(it.describe.groups[0].shape, 'cross');
    assert.equal(it.describe.shape, 'underline', 'the newest group\'s shape on top');
    assert.equal(it.summary, summary);
    assert.equal(it.why_wake, why_wake);
  });
}

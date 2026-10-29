// A grouped queue row names its members (U424a; DECISIONS.md L.9, K.2-180;
// RULED 2026-10-29 X4 = a, Y5 = b; corrective to U423's coalesced item and
// U424's rail rows).
//
//   * the group item (lib/channel/policy elementItem → mergeElement →
//     syncMembers) carries `members`: up to MEMBERS_SHOWN {id, words}
//     entries — the newest members, listed in queue order (oldest → newest),
//     each one's words the text its summary quotes, cut to MEMBER_WORDS_MAX
//     with U+2026 — and `more`, the members beyond the list. A raise is a
//     group of one (members 1, more 0). A member that leaves (the queue
//     domain's remove, re-send) leaves the list, and `more` still counts
//     every member left.
//   * `summary`, `count` and the envelope are what they were: the wake reads
//     neither field (byte-equal with and without them).
//   * the rail (public/app/queue.js membersBlock) draws a group of more than
//     one as up to three short lines under its kind line, then '+N more';
//     a single row, and an item whose list a basic viewer sees as its
//     text-free label (a string), draw as they always did.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');

const { createBus } = require('../lib/core/bus');
const { classify, mergeElement, MEMBERS_SHOWN, MEMBER_WORDS_MAX } = require('../lib/channel/policy');
const { wakeEnvelope } = require('../lib/channel/envelope');
const { stripItemText } = require('../lib/core/remote-policy');
const queue = require('../lib/server/domain/queue');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const DECLS = {
  comment: { wake: { coalesce: 'count', respond: true }, label: 'Comment' },
  highlight: { wake: true, label: 'Highlight' },
};
function freshState() {
  return {
    queue: [], queueSeq: 0, mounts: new Map(['m1', 'm2'].map((id) => [id, { id, gen: 0 }])), markdown: new Map(), store: {},
    signals: {}, wakeConsumers: 0, wakeConsumerSeenAt: 0, pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}
const pinEvent = (id, text, mount = 'm1') => ({ kind: 'comment', op: 'add', pin: { id, seq: 1, shared: true, text, anchor: { mount } } });
// The daemon's dispatch (lib/server/index.js) for an element raise.
function raise(state, bus, event) {
  const type = event.kind === 'comment' ? 'comment' : event.type;
  const c = classify(event, { elementTypes: { [type]: DECLS[type] } });
  if (c.action === 'enqueue') queue.enqueueElement(state, bus, { ...c.item, label: DECLS[type].label });
  else if (c.action === 'dequeue') queue.removeByElement(state, bus, c.element_id);
  else if (c.action === 'refresh') queue.refreshElement(state, bus, c.element_id, c.item);
}
const LONG = 'the plan reads well up to step four, then the numbers stop adding up';

// ── the group item ──────────────────────────────────────────────────────────

test('a group of 5 carries members 3 (the newest, in queue order, each cut with U+2026) and more 2; summary and count are the newest\'s and 5', () => {
  assert.equal(MEMBERS_SHOWN, 3);
  const state = freshState();
  const bus = createBus();
  const words = ['first note', 'second note', LONG, 'fourth\nnote <b>here</b>', 'fifth note'];
  words.forEach((w, i) => raise(state, bus, pinEvent(`c${i + 1}`, w)));
  assert.equal(state.queue.length, 1, 'one group');
  const [g] = state.queue;
  assert.equal(g.count, 5);
  assert.deepEqual(g.element_ids, ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.equal(g.summary, 'm1 · "fifth note"', 'the summary is the newest member\'s, as before');
  assert.deepStrictEqual(g.members.map((m) => m.id), ['c3', 'c4', 'c5'], 'the newest three, oldest first');
  assert.equal(g.more, 2);
  const cut = g.members[0].words;
  assert.ok(cut.length <= MEMBER_WORDS_MAX && cut.length > MEMBER_WORDS_MAX - 5, `cut to the member line's length (${cut.length})`);
  assert.ok(cut.endsWith('…'), 'with U+2026');
  assert.ok(LONG.startsWith(cut.slice(0, -1).trimEnd()), 'the member\'s first words');
  assert.equal(g.members[1].words, 'fourth note bhere/b', 'one line, sanitized as a summary is');
  assert.equal(g.members[2].words, 'fifth note');
});

test('a group of 1 carries members 1 and more 0; a group of 3 all three and more 0', () => {
  const state = freshState();
  const bus = createBus();
  raise(state, bus, pinEvent('c1', 'only one'));
  assert.deepStrictEqual(state.queue[0].members, [{ id: 'c1', words: 'only one' }]);
  assert.equal(state.queue[0].more, 0);
  raise(state, bus, pinEvent('c2', 'two'));
  raise(state, bus, pinEvent('c3', 'three'));
  assert.deepStrictEqual(state.queue[0].members, [{ id: 'c1', words: 'only one' }, { id: 'c2', words: 'two' }, { id: 'c3', words: 'three' }]);
  assert.equal(state.queue[0].more, 0);
  // A highlight with no note: its entry has empty words (the rail draws its id).
  raise(state, bus, { kind: 'element', type: 'highlight', op: 'add', id: 'h1', v: 1, shared: true, mount: 'm1' });
  const hl = state.queue.find((it) => it.type === 'highlight');
  assert.deepStrictEqual(hl.members, [{ id: 'h1', words: '' }]);
});

test('a reply that re-raises a queued member moves it to the end of the list with its new words; a member leaving leaves the list, more counts what is left', () => {
  const state = freshState();
  const bus = createBus();
  ['a', 'b', 'c', 'd', 'e'].forEach((w, i) => raise(state, bus, pinEvent(`c${i + 1}`, w)));
  // c2 re-raised (a user reply quotes the reply: the THREAD rule).
  const c2 = { kind: 'comment', op: 'reply', author: 'user', pin: { id: 'c2', seq: 1, shared: true, text: 'b', anchor: { mount: 'm1' }, replies: [{ author: 'user', text: 'b again' }] } };
  raise(state, bus, c2);
  const [g] = state.queue;
  assert.deepEqual(g.element_ids, ['c1', 'c3', 'c4', 'c5', 'c2']);
  assert.deepStrictEqual(g.members, [{ id: 'c4', words: 'd' }, { id: 'c5', words: 'e' }, { id: 'c2', words: 'b again' }]);
  assert.equal(g.more, 2);
  const prior = g.members;
  // c5 deleted: the list loses it (the successor's words are not on the item).
  queue.removeByElement(state, bus, 'c5');
  assert.deepStrictEqual(g.members, [{ id: 'c4', words: 'd' }, { id: 'c2', words: 'b again' }]);
  assert.equal(g.count, 4);
  assert.equal(g.more, 2, 'count − the listed members');
  assert.equal(prior.length, 3, 'a fresh list: a frame already served keeps its own (F7)');
  // An older member leaving changes only more.
  queue.removeByElement(state, bus, 'c1');
  assert.deepStrictEqual(g.members.map((m) => m.id), ['c4', 'c2']);
  assert.equal(g.more, 1);
  // The next raise lists itself.
  raise(state, bus, pinEvent('c6', 'f'));
  assert.deepStrictEqual(g.members.map((m) => m.id), ['c4', 'c2', 'c6']);
  assert.equal(g.more, 1);
  assert.equal(g.count, 4);
});

test('an in-place edit of a listed member refreshes its words on the item and the update frame (refreshElement); a frame already served keeps its own', () => {
  const state = freshState();
  const bus = createBus();
  const frames = [];
  bus.subscribe((e) => { if (e.kind === 'queue') frames.push(e); });
  raise(state, bus, pinEvent('c1', 'first'));
  raise(state, bus, pinEvent('c2', 'second'));
  const [g] = state.queue;
  const served = frames[frames.length - 1].item.members;
  raise(state, bus, { kind: 'comment', op: 'edit', pin: { id: 'c2', seq: 1, shared: true, text: 'EDITED second', anchor: { mount: 'm1' } } });
  assert.equal(state.queue.length, 1, 'still one group');
  assert.equal(g.summary, 'm1 · "EDITED second"');
  assert.deepStrictEqual(g.members, [{ id: 'c1', words: 'first' }, { id: 'c2', words: 'EDITED second' }], 'the edited member\'s new words, never the retracted ones');
  const last = frames[frames.length - 1];
  assert.equal(last.op, 'update');
  assert.equal(last.item.members[1].words, 'EDITED second', 'the update frame carries the new words');
  assert.deepStrictEqual(served.map((m) => m.words), ['first', 'second'], 'a frame already served keeps its own (F7)');
  // An older member edited in place: its line changes, the summary stays the newest's.
  raise(state, bus, { kind: 'comment', op: 'edit', pin: { id: 'c1', seq: 1, shared: true, text: 'EDITED first', anchor: { mount: 'm1' } } });
  assert.deepStrictEqual(g.members.map((m) => m.words), ['EDITED first', 'EDITED second']);
  assert.equal(g.summary, 'm1 · "EDITED second"');
});

test('the wake and the envelope are byte-equal with and without members and more; the update frame carries them', () => {
  const state = freshState();
  const bus = createBus();
  const frames = [];
  bus.subscribe((e) => { if (e.kind === 'queue') frames.push(e); });
  ['one', 'two', 'three', 'four'].forEach((w, i) => raise(state, bus, pinEvent(`c${i + 1}`, w)));
  const g = state.queue[0];
  const bare = { ...g };
  delete bare.members;
  delete bare.more;
  for (const opts of [{}, { note: 'look at these', reason: 'push', source: 'queue' }]) {
    assert.deepStrictEqual(wakeEnvelope([g], opts), wakeEnvelope([bare], opts), 'the envelope reads neither field');
    assert.equal(JSON.stringify(wakeEnvelope([g], opts)), JSON.stringify(wakeEnvelope([bare], opts)));
  }
  assert.ok(!wakeEnvelope([g]).content.includes('two'), 'an older member\'s words never reach the wake');
  const last = frames[frames.length - 1];
  assert.equal(last.op, 'update');
  assert.deepStrictEqual(last.item.members.map((m) => m.id), ['c2', 'c3', 'c4']);
  assert.equal(last.item.more, 1);
});

test('below read the members are the item\'s text-free label; at read and above the item itself', () => {
  const state = freshState();
  const bus = createBus();
  ['secret-ish one', 'secret-ish two'].forEach((w, i) => raise(state, bus, pinEvent(`c${i + 1}`, w)));
  const g = Object.freeze(JSON.parse(JSON.stringify(state.queue[0])));
  for (const level of ['read', 'full', 'local']) assert.equal(stripItemText(g, level), g, level);
  for (const level of ['basic', undefined]) {
    const out = stripItemText(g, level);
    assert.equal(out.members, 'm1 · comment');
    assert.equal(out.more, 0, 'a count, kept');
    assert.ok(!JSON.stringify(out).includes('secret-ish'), String(level));
  }
});

// ── the rail ────────────────────────────────────────────────────────────────

const WAIT = { timeout: 3000 };
const QUEUE = {
  items: [
    { id: 'q-five', kind: 'element', type: 'comment', label: 'Comment', element_id: 'c5', element_ids: ['c1', 'c2', 'c3', 'c4', 'c5'],
      v: 1, count: 5, respond: true, summary: 'p1 · "fifth"', why_wake: 'comment pinned for Claude', source: 'browser',
      origin_mount: 'p1', staged: true,
      members: [{ id: 'c3', words: 'third <b>note</b>' }, { id: 'c4', words: '' }, { id: 'c5', words: 'fifth' }], more: 2 },
    { id: 'q-two', kind: 'element', type: 'highlight', label: 'Highlight', element_id: 'h2', element_ids: ['h1', 'h2'],
      v: 1, count: 2, summary: 'two highlights', why_wake: 'Highlight sent to Claude', source: 'browser', origin_mount: 'p1', staged: true,
      members: [{ id: 'h1', words: 'one' }, { id: 'h2', words: 'two' }], more: 0 },
    { id: 'q-one', kind: 'element', type: 'zz-unlisted', element_id: 'z1', element_ids: ['z1'],
      v: 1, count: 1, summary: 'a single one', why_wake: 'sent', source: 'browser', staged: true,
      members: [{ id: 'z1', words: 'a single one' }], more: 0 },
    { id: 'q-legacy', kind: 'element', type: 'zz-unlisted', element_id: 'z3', element_ids: ['z2', 'z3'],
      v: 1, count: 2, summary: 'from an older draft', source: 'browser', staged: true },
    { id: 'q-basic', kind: 'element', type: 'zz-unlisted', element_id: 'z5', element_ids: ['z4', 'z5'],
      v: 1, count: 2, summary: 'p1 · zz-unlisted', members: 'p1 · zz-unlisted', more: 0, text_hidden: true, source: 'browser', staged: true },
  ],
  count: 5,
};

let shell, W;
before(async () => {
  shell = await bootShell({
    routes: {
      '/api/queue': () => JSON.parse(JSON.stringify(QUEUE)),
      '/api/queue/*': () => ({ ok: true }),
      '/api/elements*': () => ({ ok: true, elements: [] }),
    },
  });
  W = shell.window;
  await shell.importApp('queue.js');
  await shell.frame(helloFrame());
  await waitUntil(() => row('q-five') && row('q-basic'), { ...WAIT, what: 'the queue rail' });
});
after(async () => { await shell.restore(); });

const row = (id) => W.document.querySelector(`#queue-rail .rail-item[data-id="${id}"]`);
const lines = (id) => [...row(id).querySelectorAll('.qi-members > .qi-member')].map((el) => [el.className, el.textContent]);

test('the rail: a group of 5 draws three member lines under its kind line, then \'+2 more\'; an empty member reads its id; text, never markup', () => {
  const r = row('q-five');
  const box = r.querySelector('.qi-members');
  assert.ok(box, 'the member block');
  assert.equal(box.previousElementSibling && box.previousElementSibling.className, 'qi-top', 'under the kind line');
  assert.deepStrictEqual(lines('q-five'), [
    ['qi-member', 'third <b>note</b>'],
    ['qi-member qi-member-id', 'c4'],
    ['qi-member', 'fifth'],
    ['qi-member qi-more', '+2 more'],
  ]);
  assert.equal(box.querySelector('b'), null, 'no markup drawn');
  assert.deepStrictEqual([...box.querySelectorAll('[data-member]')].map((el) => el.dataset.member), ['c3', 'c4', 'c5']);
  assert.ok(/×5/.test(r.querySelector('.qi-kind').textContent), 'the kind line keeps its count');
});

test('the rail: a group of 2 draws its two lines and no \'+N more\'', () => {
  assert.deepStrictEqual(lines('q-two'), [['qi-member', 'one'], ['qi-member', 'two']]);
});

test('the rail: a single row, a legacy group with no list and a basic viewer\'s label draw no member block — the row as it was', () => {
  for (const id of ['q-one', 'q-legacy', 'q-basic']) {
    const r = row(id);
    assert.equal(r.querySelector('.qi-members'), null, id);
    assert.deepStrictEqual([...r.querySelector('.qi-body').children].map((el) => el.className), ['qi-top', 'qi-why', 'qi-summary'], id);
  }
  assert.equal(row('q-one').querySelector('.qi-summary').textContent, 'a single one');
});

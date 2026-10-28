// One declarative wake for every element type (annotation engine tranche 3,
// U423; PLAN.md 3B.2; DECISIONS.md D2, K.2-10; readiness R5 M4, M5, S-7's two
// conditions; the carried condition C-14-1).
//
//   * element.json's `wake` is false | true | {coalesce?, respond?}, read by
//     ONE reader (lib/packs/elements wakeOf); comment and chat-comment
//     declare {coalesce: 'count', respond: true}.
//   * Every type — the comment included — rides one declarative path in
//     lib/channel/policy (classify over a normalised event): the 38 cells of
//     F8 s7 (10 ops × 4 pin states + 2 adds) keep cf3af5d's action column,
//     and the item is the element group; threads (the reply op and its
//     self-wake gate) are generic to every {respond: true} type.
//   * The comment's summary is commentItem's string at U406's head, byte for
//     byte; a highlight's is cf3af5d's elementItem string; a chat pin's reads
//     'on <its record's anchor.label> · "<text>"' (S4), a private chain
//     member 'a private element' (Q8).
//   * A refresh is one update frame of refreshComment's shape (GT-14's frame
//     clause, notes-B Q-2 (a)).
//   * RESPOND_HINT rides any respond type's group or a legacy comment item.
//   * C-14-1: a parked batch names every element id in its content; the
//     live path keeps them in the ring's wake entry.
//   * The delivery-time excerpt gate: a Push after `excerpts off` is ids-only.
//   * Send to Claude raises what a share raises; a node restore, a Wipe, a
//     bulk clear and New graph never drop a chat-comment member; ⟲ on a group
//     deletes nothing; a legacy comment item from an older draft still works.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { withServer, commentBody, waitUntil } = require('../test-support/helpers');
const { createBus } = require('../lib/core/bus');
const { createRedactor } = require('../lib/core/redact');
const { SCHEMAS } = require('../lib/core/element-log');
const { setSwitch } = require('../lib/core/excerpts');
const { classify, commentItem, elementItem, COMMENT_DECL } = require('../lib/channel/policy');
const {
  wakeEnvelope, RESPOND_HINT, EXCERPT_HEADER, EXCERPT_PREFIX, ELEMENT_IDS_LINE_MAX, wholeIds,
} = require('../lib/channel/envelope');
const { wakeOf, toolbarFields, readElementJson } = require('../lib/packs/elements');
const { ELEMENTS_TEMPLATE_DIR } = require('../lib/server/builtins');
const { elementEvent, removeElement } = require('../lib/server/domain/comments');
const queue = require('../lib/server/domain/queue');

const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');
const builtin = (type) => readElementJson(path.join(ELEMENTS_TEMPLATE_DIR, 'elements', type)).raw;

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const groupOf = (items, id) => items.find((it) => it.kind === 'element' && (it.element_ids || [it.element_id]).includes(id));

// ── (1) the declaration ─────────────────────────────────────────────────────

test('wakeOf: the one reader — true reads as count, the object form with its defaults; false, absent or a refused form raise nothing', () => {
  assert.deepStrictEqual(wakeOf({ wake: true }), { coalesce: 'count', respond: false }, 'a 0.8.x manifest keeps working');
  assert.deepStrictEqual(wakeOf({ wake: {} }), { coalesce: 'count', respond: false });
  assert.deepStrictEqual(wakeOf({ wake: { coalesce: 'none' } }), { coalesce: 'none', respond: false });
  assert.deepStrictEqual(wakeOf({ toolbar: { wake: { respond: true } } }), { coalesce: 'count', respond: true }, 'a descriptor reads through its toolbar');
  for (const w of [false, undefined, 'yes', 1, { coalesce: 'all' }, { respond: 'yes' }, { when: 1 }, []]) {
    assert.equal(wakeOf({ wake: w }), null, JSON.stringify(w));
  }
  assert.equal(wakeOf(null), null);
});

test('the grammar: {coalesce: \'none\'} is accepted; a coalesce outside the two words, a non-boolean respond and an unknown key are refused naming wake.<key>', () => {
  assert.deepStrictEqual(toolbarFields({ wake: { coalesce: 'none' } }, null), { ok: true, errors: [] });
  assert.deepStrictEqual(toolbarFields({ wake: { coalesce: 'count', respond: false } }, null), { ok: true, errors: [] });
  assert.deepStrictEqual(toolbarFields({ wake: true }, null), { ok: true, errors: [] });
  const fieldsOf = (w) => toolbarFields({ wake: w }, null).errors.map((e) => e.field);
  assert.deepStrictEqual(fieldsOf({ coalesce: 'all' }), ['wake.coalesce']);
  assert.deepStrictEqual(fieldsOf({ respond: 'yes' }), ['wake.respond']);
  assert.deepStrictEqual(fieldsOf({ also: true }), ['wake.also']);
  assert.deepStrictEqual(fieldsOf('yes'), ['wake']);
});

test('the built-ins: comment and chat-comment declare {coalesce: \'count\', respond: true}; highlight and box grab keep true; the policy\'s comment fallback is element.json\'s', () => {
  assert.deepStrictEqual(builtin('comment').wake, { coalesce: 'count', respond: true });
  assert.deepStrictEqual(builtin('chat-comment').wake, { coalesce: 'count', respond: true });
  assert.equal(builtin('highlight').wake, true);
  assert.equal(builtin('box-grab').wake, true);
  assert.deepStrictEqual(wakeOf(builtin('comment')), { ...COMMENT_DECL.wake });
  assert.equal(COMMENT_DECL.label, builtin('comment').label);
});

// ── (2) the 38 cells (F8 s7) over the real routes ───────────────────────────

const ANCHOR = { mount: 'pane-a', selector: 'p:nth-of-type(2)', text: 'the retry loop', ordinal: 0 };
const OPS = {
  'add-shared': [['post', '/api/elements', commentBody({ text: 'first note', shared: true, anchor: ANCHOR })]],
  'add-private': [['post', '/api/elements', commentBody({ text: 'first note', shared: false, anchor: ANCHOR })]],
  'edit-text': [['patch', ':id', { text: 'edited note' }]],
  share: [['patch', ':id', { shared: true }]],
  unshare: [['patch', ':id', { shared: false }]],
  'edit-and-share': [['patch', ':id', { text: 'edited note', shared: true }]],
  'edit-and-unshare': [['patch', ':id', { text: 'edited note', shared: false }]],
  'reply-user': [['post', ':id/reply', { text: 'user reply', author: 'user' }]],
  'reply-claude': [['post', ':id/reply', { text: 'claude reply', author: 'claude' }]],
  'reshare-after-claude': [
    ['post', ':id/reply', { text: 'user reply', author: 'user' }],
    ['post', ':id/reply', { text: 'claude reply', author: 'claude' }],
    ['patch', ':id', { shared: false }],
    ['patch', ':id', { shared: true }],
  ],
  delete: [['del', ':id', null]],
};
// The table: [state, op, route statuses, cf3af5d's classify actions over the
// op's comment events (recorded from cf3af5d's lib/channel/policy.js over the
// same events), the item left standing for the pin: null | [summary,
// why_wake]]. private-queued is injected (no route queues a private pin).
const P = 'comment pinned for Claude';
const R = 'comment reply';
const FIRST = ['pane-a · "first note"', P];
const EDITED = ['pane-a · "edited note"', P];
const REPLIED = ['pane-a · "user reply"', R];
const CELLS = [
  ['none', 'add-shared', [200], ['enqueue'], FIRST],
  ['none', 'add-private', [200], [null], null],
  ['shared-queued', 'edit-text', [200], ['refresh'], EDITED],
  ['shared-queued', 'share', [200], [], FIRST],
  ['shared-queued', 'unshare', [200], ['dequeue'], null],
  ['shared-queued', 'edit-and-share', [200], ['refresh'], EDITED],
  ['shared-queued', 'edit-and-unshare', [200], ['dequeue'], null],
  ['shared-queued', 'reply-user', [200], ['enqueue'], REPLIED],
  ['shared-queued', 'reply-claude', [200], [null], FIRST],
  ['shared-queued', 'reshare-after-claude', [200, 200, 200, 200], ['enqueue', null, 'dequeue', 'enqueue'], REPLIED],
  ['shared-queued', 'delete', [200], ['dequeue'], null],
  ['shared-unqueued', 'edit-text', [200], ['refresh'], null],
  ['shared-unqueued', 'share', [200], [], null],
  ['shared-unqueued', 'unshare', [200], ['dequeue'], null],
  ['shared-unqueued', 'edit-and-share', [200], ['refresh'], null],
  ['shared-unqueued', 'edit-and-unshare', [200], ['dequeue'], null],
  ['shared-unqueued', 'reply-user', [200], ['enqueue'], REPLIED],
  ['shared-unqueued', 'reply-claude', [200], [null], null],
  ['shared-unqueued', 'reshare-after-claude', [200, 200, 200, 200], ['enqueue', null, 'dequeue', 'enqueue'], REPLIED],
  ['shared-unqueued', 'delete', [200], ['dequeue'], null],
  ['private-unqueued', 'edit-text', [200], ['dequeue'], null],
  ['private-unqueued', 'share', [200], ['enqueue'], FIRST],
  ['private-unqueued', 'unshare', [200], [], null],
  ['private-unqueued', 'edit-and-share', [200], ['enqueue'], EDITED],
  ['private-unqueued', 'edit-and-unshare', [200], ['dequeue'], null],
  ['private-unqueued', 'reply-user', [200], [null], null],
  ['private-unqueued', 'reply-claude', [404], [], null],
  ['private-unqueued', 'reshare-after-claude', [200, 404, 200, 200], [null, 'enqueue'], REPLIED],
  ['private-unqueued', 'delete', [200], ['dequeue'], null],
  ['private-queued', 'edit-text', [200], ['dequeue'], null],
  ['private-queued', 'share', [200], ['enqueue'], FIRST],
  ['private-queued', 'unshare', [200], [], FIRST],
  ['private-queued', 'edit-and-share', [200], ['enqueue'], EDITED],
  ['private-queued', 'edit-and-unshare', [200], ['dequeue'], null],
  ['private-queued', 'reply-user', [200], [null], FIRST],
  ['private-queued', 'reply-claude', [404], [], FIRST],
  ['private-queued', 'reshare-after-claude', [200, 404, 200, 200], [null, 'enqueue'], REPLIED],
  ['private-queued', 'delete', [200], ['dequeue'], null],
];

test('the 38 cells: the comment over the declarative path keeps cf3af5d\'s action column; the item is the comment\'s element group', async (t) => {
  assert.equal(CELLS.length, 38);
  for (const [st, op, statuses, actions, want] of CELLS) {
    await t.test(`${st} · ${op}`, async (tt) => {
      const { api, srv } = await withServer(tt);
      await ok(api.post('/api/render', { id: 'pane-a', html: '<p>one</p><p>the retry loop</p>' }), 'render');
      let id = null;
      if (st !== 'none') {
        id = (await ok(api.post('/api/elements', commentBody({ text: 'first note', shared: st.startsWith('shared'), anchor: ANCHOR })), 'pin')).pin.id;
        if (st === 'shared-unqueued') for (const it of srv.state.queue.slice()) queue.remove(srv.state, srv.bus, it.id);
        if (st === 'private-queued') {
          const pin = srv.state.comments.find((c) => c.id === id);
          queue.enqueueElement(srv.state, srv.bus, commentItem({ ...pin, shared: true }));
        }
      }
      const seen = [];
      srv.bus.subscribe((e) => { if (e && e.kind === 'comment') seen.push(e); });
      const got = [];
      for (const [m, p, body] of OPS[op]) {
        const url = p.startsWith(':id') ? `/api/elements/${id}${p.slice(3)}` : p;
        const r = await api[m](url, body);
        got.push(r.status);
        if (!id && r.json && r.json.pin) id = r.json.pin.id;
      }
      assert.deepStrictEqual(got, statuses, 'the route statuses');
      assert.deepStrictEqual(seen.map((e) => { const c = classify(e); return c ? c.action : null; }), actions, 'the action column (cf3af5d\'s)');
      for (const e of seen) {
        const c = classify(e);
        if (c && (c.action === 'dequeue' || c.action === 'refresh')) assert.equal(c.element_id, id, 'keyed on the element id');
      }
      const items = srv.state.queue.filter((it) => (it.element_ids || []).includes(id) || it.comment_id === id);
      if (!want) { assert.deepStrictEqual(items, [], 'nothing stands for the pin'); return; }
      assert.equal(items.length, 1, 'one item');
      const [g] = items;
      assert.deepStrictEqual(
        [g.kind, g.type, g.element_id, g.element_ids, g.count, g.respond, g.summary, g.why_wake, g.origin_mount, g.staged, 'comment_id' in g],
        ['element', 'comment', id, [id], 1, true, want[0], want[1], 'pane-a', true, false],
        'the group shape',
      );
    });
  }
});

// ── (3) every type through one path ────────────────────────────────────────

test('highlight, box grab and a chat-comment through add, grab, edit, share, unshare, delete and pending; a type with no wake raises none', () => {
  const ev = (type, op, extra = {}) => ({ kind: 'element', type, op, id: 'x1', v: 1, shared: true, mount: type === 'chat-comment' ? null : 'm1', ...extra });
  const DECL = {
    highlight: { wake: true, label: 'Highlight', text: 'n' },
    'box-grab': { wake: true, label: 'Box grab' },
    'chat-comment': { wake: { coalesce: 'count', respond: true }, label: 'Comment', where: 'on turn 3', text: 'n' },
  };
  for (const type of Object.keys(DECL)) {
    const types = { elementTypes: { [type]: DECL[type] } };
    const act = (op, extra) => { const c = classify(ev(type, op, extra), types); return c ? c.action : null; };
    assert.equal(act('add'), 'enqueue', `${type} add`);
    assert.equal(act('grab'), 'enqueue', `${type} grab`);
    assert.equal(act('send'), 'enqueue', `${type} send`);
    assert.equal(act('edit'), 'refresh', `${type} edit`);
    assert.equal(act('edit', { was_shared: false }), 'enqueue', `${type} share`);
    assert.equal(act('edit', { shared: false }), 'dequeue', `${type} unshare`);
    assert.equal(act('delete'), 'dequeue', `${type} delete`);
    assert.equal(act('add', { pending: 'image' }), null, `${type} pending`);
    assert.equal(act('add', { shared: false }), null, `${type} a private add`);
    assert.equal(act('anchor'), null, `${type} an anchor move`);
    assert.equal(classify(ev(type, 'add'), { elementTypes: { [type]: { ...DECL[type], wake: false } } }), null, `${type} with no wake`);
    assert.equal(classify(ev(type, 'add'), {}), null, `${type} unlisted`);
  }
  assert.equal(classify(ev('highlight', 'reply', { author: 'user' }), { elementTypes: { highlight: DECL.highlight } }), null, 'a type that does not respond has no thread');
});

// ── (4) threads are generic: the comment and the chat comment ──────────────

test('the reply cells: a user reply raises and quotes the newest user reply; Claude\'s raises nothing — for the comment and for a second thread-bearing type (chat-comment)', () => {
  const replies = [{ author: 'user', text: 'first ask' }, { author: 'claude', text: 'my answer' }, { author: 'user', text: 'no, the OTHER column' }];
  // The comment: its pin rides the event.
  const pin = { id: 'c3', seq: 15, shared: true, text: 'root', anchor: { mount: 'm1' }, replies };
  const user = classify({ kind: 'comment', op: 'reply', author: 'user', pin });
  assert.deepStrictEqual([user.action, user.item.summary, user.item.why_wake, user.item.respond], ['enqueue', 'm1 · "no, the OTHER column"', 'comment reply', true]);
  assert.equal(classify({ kind: 'comment', op: 'reply', author: 'claude', pin: { ...pin, replies: [...replies, { author: 'claude', text: 'done' }] } }), null, 'the self-wake gate');
  // The chat comment: an element event carrying author (U416's), its words from the record.
  const decl = { wake: { coalesce: 'count', respond: true }, label: 'Comment', where: 'on turn 12\'s reply', text: 'root', replies };
  const ev = { kind: 'element', type: 'chat-comment', op: 'reply', id: 'k4', v: 3, shared: true, mount: null };
  const chat = classify({ ...ev, author: 'user' }, { elementTypes: { 'chat-comment': decl } });
  assert.deepStrictEqual([chat.action, chat.item.summary, chat.item.why_wake, chat.item.respond], ['enqueue', 'on turn 12\'s reply · "no, the OTHER column"', 'comment reply', true]);
  assert.equal(classify({ ...ev, author: 'claude' }, { elementTypes: { 'chat-comment': decl } }), null, 'Claude\'s reply raises nothing');
  // With no user reply after Claude's, the root is quoted, never Claude.
  const rootOnly = classify({ ...ev, op: 'add' }, { elementTypes: { 'chat-comment': { ...decl, replies: [{ author: 'claude', text: 'recomputed' }] } } });
  assert.deepStrictEqual([rootOnly.item.summary, rootOnly.item.why_wake], ['on turn 12\'s reply · "root"', 'comment pinned for Claude']);
  // A user reply on a QUEUED pin refreshes its member in place (no second item).
  const state = { queue: [], queueSeq: 0, mounts: new Map([['m1', { id: 'm1' }]]) };
  const bus = createBus();
  queue.enqueueElement(state, bus, classify({ kind: 'comment', op: 'add', pin: { ...pin, replies: [] } }).item);
  queue.enqueueElement(state, bus, user.item);
  assert.deepStrictEqual(state.queue.map((it) => [it.element_ids, it.summary]), [[['c3'], 'm1 · "no, the OTHER column"']]);
});

// The comment's summary at U406's merge head (a9356eb's commentItem; mount,
// section words, chain words, the quoted text) and a highlight's at cf3af5d
// (its elementItem), recorded byte for byte.
const AT_U406 = [
  [{ id: 'c1', seq: 3, shared: true, text: 'totals look off', anchor: { mount: 'm1' } }, [], 'm1 · "totals look off"', 'comment pinned for Claude'],
  [{ id: 'c2', seq: 4, shared: true, text: 'why this colour?', anchor: { mount: 'm1' }, chain: ['h7', 'g3', 'c2x'] }, [], 'm1 · on highlight h7 › box grab g3 › element c2x · "why this colour?"', 'comment pinned for Claude'],
  [{ id: 'c2', seq: 4, shared: true, text: 'why this colour?', anchor: { mount: 'm1' }, chain: ['h7', 'g3', 'c2x'] }, ['g3'], 'm1 · on highlight h7 › a private element › element c2x · "why this colour?"', 'comment pinned for Claude'],
  [{ id: 'c3', seq: 5, shared: true, text: 'is this the right order?', anchor: { v: 1, kind: 'source', md: 'md-2' }, locator: { mount: 'md-2', selector: 'h2', text: 'Options', ordinal: 0, section: 'Options and the long tail of a section heading that runs past sixty characters' } }, [], 'md-2 · on section "Options and the long tail of a section heading that runs pas…" · "is this the right order?"', 'comment pinned for Claude'],
  [{ id: 'c4', seq: 6, shared: true, text: 'root', anchor: { mount: 'm1' }, replies: [{ author: 'user', text: 'first ask' }, { author: 'claude', text: 'my answer' }, { author: 'user', text: 'no, the OTHER column' }] }, [], 'm1 · "no, the OTHER column"', 'comment reply'],
  [{ id: 'c5', seq: 7, shared: true, text: 'the totals', anchor: { mount: 'm1' }, replies: [{ author: 'claude', text: 'recomputed' }] }, [], 'm1 · "the totals"', 'comment pinned for Claude'],
  [{ id: 'c6', seq: 8, shared: true, text: '', anchor: null }, [], 'comment', 'comment pinned for Claude'],
];
const AT_CF3AF5D = [
  [{ label: 'Highlight', text: 'see <this>\nnow' }, 'Highlight · h1@2 · "see this now"'],
  [{ label: 'Highlight', text: '' }, 'Highlight · h1@2'],
  [{ label: '', text: 'x' }, 'highlight · h1@2 · "x"'],
];

test('the summaries: the comment\'s equals commentItem\'s at U406\'s head (mount, section, chain, the quote); a highlight\'s equals cf3af5d\'s elementItem', () => {
  for (const [pin, hidden, summary, why] of AT_U406) {
    const wrapped = commentItem(pin, { hidden });
    assert.deepStrictEqual([wrapped.summary, wrapped.why_wake], [summary, why], `commentItem ${pin.id} ${hidden}`);
    const c = classify({ kind: 'comment', op: 'add', pin, chain_private: hidden });
    assert.deepStrictEqual([c.item.summary, c.item.why_wake, c.item.kind, c.item.element_id], [summary, why, 'element', pin.id], `declarative ${pin.id} ${hidden}`);
  }
  const ev = { kind: 'element', type: 'highlight', op: 'add', id: 'h1', v: 2, shared: true, mount: 'm1' };
  for (const [decl, summary] of AT_CF3AF5D) {
    const item = elementItem(ev, decl);
    assert.equal(item.summary, summary);
    assert.equal(item.why_wake, `${decl.label || 'highlight'} sent to Claude`);
    assert.ok(!('respond' in item) && !('coalesce' in item), 'a highlight declares neither');
  }
  assert.equal(elementItem(ev, { label: 'S', text: 'y'.repeat(400) }).summary.length, 200, 'the queue\'s cap');
  assert.equal(elementItem(ev, { wake: { coalesce: 'none' }, label: 'S' }).coalesce, 'none', 'a word, no text');
});

// ── (5) the chat pin's words through the daemon (S4, Q8) ───────────────────

const CHAT_ANCHOR = (label) => ({
  v: 1, conversation_id: 'conv-u423', session_id: 'sess-u423', turn_id: 't_12', kind: 'item-range', item_id: 'r_t_12_0', field: 'text',
  quote: { exact: 'two parts', prefix: 'The plan has ', suffix: '.' }, pos: { start: 13, end: 22 }, ordinal: { index: 0, of: 1 },
  fp: { h: '0123456789abcdef', len: 48 }, marks: 0, label,
});
function addChat(srv, { text = 'text', label = 'turn 12\'s reply', chain = [], shared = true } = {}) {
  return srv.elements.addElement({ type: 'chat-comment', schema: CHAT, payload: { text, shared, replies: [], anchor: CHAT_ANCHOR(label), chain }, author: 'user' });
}
function raiseChat(srv, rec, extra = {}) {
  srv.bus.emit({ event: { ...elementEvent(srv.state, 'add', rec), ...extra } });
}

test('a chat pin\'s queue line names its place from the record\'s label, masked at read (S4); a private chain member reads \'a private element\' (Q8)', async (t) => {
  const { srv } = await withServer(t);
  const a = addChat(srv, { text: 'text' });
  raiseChat(srv, a);
  let g = groupOf(srv.state.queue, a.id);
  assert.ok(g, 'the chat pin queued');
  assert.deepStrictEqual([g.type, g.origin_mount, g.summary, g.why_wake, g.respond], ['chat-comment', null, 'on turn 12\'s reply · "text"', 'comment pinned for Claude', true]);
  const line = wakeEnvelope([g]).content;
  assert.ok(line.includes('- [element] on turn 12\'s reply · "text"'), line);
  assert.ok(line.includes(RESPOND_HINT), 'a respond type: the hint');

  const SECRET = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const b = addChat(srv, { text: 'second', label: `turn 12's reply ${SECRET}` });
  raiseChat(srv, b);
  g = groupOf(srv.state.queue, b.id);
  assert.equal(g, groupOf(srv.state.queue, a.id), 'one group per type for every chat pin (Q9)');
  assert.ok(!JSON.stringify(g).includes(SECRET), 'the label is masked at read');
  assert.equal(g.summary, createRedactor().value(`on turn 12's reply ${SECRET} · "second"`));

  const c = addChat(srv, { text: 'chained', chain: ['h7', 'g3'] });
  raiseChat(srv, c, { chain_private: ['g3'] });
  g = groupOf(srv.state.queue, c.id);
  assert.equal(g.summary, 'on turn 12\'s reply · on highlight h7 › a private element · "chained"');
  assert.ok(!g.summary.includes('g3') && !g.summary.includes('box grab'), 'no type and no id');
  assert.deepStrictEqual(g.element_ids, [a.id, b.id, c.id]);
  const content = wakeEnvelope([g]).content;
  assert.ok(content.includes(`· 3 in this group: ${a.id},${b.id},${c.id}`), content);
});

// ── (6) the frame clause (GT-14; notes-B Q-2 (a)) ───────────────────────────

test('one update frame per refresh of a one-pin comment group, in refreshComment\'s shape: summary, why_wake, staged, count', () => {
  const pin = { id: 'c1', seq: 1, shared: true, text: 'before', anchor: { mount: 'm1' } };
  const edited = { ...pin, text: 'after' };
  const frames = (fn) => {
    const state = { queue: [], queueSeq: 0, mounts: new Map([['m1', { id: 'm1' }]]) };
    const seen = [];
    const bus = { emit: (f) => { if (f.event.kind === 'queue' && f.event.op === 'update') seen.push(f); } };
    fn(state, bus);
    return seen;
  };
  const legacy = frames((state, bus) => {
    queue.enqueue(state, bus, { kind: 'comment', source: 'browser', comment_id: 'c1', why_wake: 'comment pinned for Claude', summary: 'm1 · "before"', origin_mount: 'm1', seq: 1 });
    queue.refreshComment(state, bus, 'c1', { summary: 'm1 · "after"', why_wake: 'comment pinned for Claude' });
  });
  const declarative = frames((state, bus) => {
    queue.enqueueElement(state, bus, classify({ kind: 'comment', op: 'add', pin }).item);
    const c = classify({ kind: 'comment', op: 'edit', pin: edited });
    assert.equal(c.action, 'refresh');
    queue.refreshElement(state, bus, c.element_id, c.item);
  });
  assert.equal(legacy.length, 1);
  assert.equal(declarative.length, 1, 'one frame per refresh');
  const [l] = legacy;
  const [d] = declarative;
  assert.deepStrictEqual(Object.keys(d.event), Object.keys(l.event), 'the event\'s shape');
  assert.deepStrictEqual(Object.keys(d.ws), Object.keys(l.ws), 'the WS frame\'s shape');
  for (const k of ['type', 'op', 'staged', 'count']) assert.deepStrictEqual(d.ws[k], l.ws[k], `ws.${k}`);
  for (const k of ['summary', 'why_wake', 'origin_mount', 'staged', 'seq']) assert.deepStrictEqual(d.ws.item[k], l.ws.item[k], `item.${k}`);
  assert.equal(d.ws.item.kind, 'element', 'K.2-10: the item kind is element');
});

// ── (7) the hint ────────────────────────────────────────────────────────────

test('RESPOND_HINT: once for a batch holding a respond type\'s group or a legacy comment item; never for a highlight-only batch', () => {
  const count = (batch) => (wakeEnvelope(batch).content.match(/respond-to-comment/g) || []).length;
  const hl = { id: 'q1', kind: 'element', type: 'highlight', element_id: 'h1', element_ids: ['h1'], summary: 'Highlight · h1@1' };
  const pins = { id: 'q2', kind: 'element', type: 'comment', element_id: 'c2', element_ids: ['c1', 'c2'], respond: true, summary: 'm1 · "x"' };
  const chat = { id: 'q3', kind: 'element', type: 'chat-comment', element_id: 'k1', element_ids: ['k1'], respond: true, summary: 'on turn 1 · "y"' };
  const legacy = { id: 'q4', kind: 'comment', comment_id: 'c9', summary: 'm1 · "z"' };
  assert.equal(count([hl]), 0);
  assert.equal(count([hl, { ...hl, id: 'q5' }]), 0);
  assert.equal(count([hl, pins]), 1);
  assert.equal(count([pins, chat, legacy]), 1, 'once, not per item');
  assert.equal(count([legacy]), 1, 'a legacy comment item still carries it');
  assert.ok(wakeEnvelope([pins]).content.endsWith(RESPOND_HINT), 'last');
});

test('a group\'s line: its summary then ` · N in this group: ` and its ids whole within ELEMENT_IDS_LINE_MAX; a one-member line is the element line as it was', () => {
  assert.equal(ELEMENT_IDS_LINE_MAX, 400);
  const one = { id: 'q1', kind: 'element', type: 'highlight', element_id: 'h1', element_ids: ['h1'], count: 1, summary: 'Highlight · h1@1' };
  const before = { id: 'q1', kind: 'element', type: 'highlight', element_id: 'h1', summary: 'Highlight · h1@1' };
  assert.equal(wakeEnvelope([one]).content, wakeEnvelope([before]).content, 'byte-identical');
  const ids = Array.from({ length: 120 }, (_, i) => `h${1000 + i}`);
  const many = { ...one, element_ids: ids, element_id: ids.at(-1), count: ids.length, summary: `Highlight · ${ids.at(-1)}@1` };
  const line = wakeEnvelope([many]).content.split('\n').find((l) => l.startsWith('- [element]'));
  const tail = line.split(' in this group: ')[1];
  assert.equal(tail, wholeIds(ids, ELEMENT_IDS_LINE_MAX));
  assert.ok(tail.length <= ELEMENT_IDS_LINE_MAX);
  assert.match(tail, /,\+\d+$/, 'whole ids, then the count of the rest');
  assert.ok(tail.split(',').slice(0, -1).every((id) => ids.includes(id)), 'no id is cut');
  assert.ok(line.startsWith(`- [element] Highlight · ${ids.at(-1)}@1 · 120 in this group: `));
});

// ── (8) C-14-1: every id reachable ─────────────────────────────────────────

function cState(consumers) {
  const mounts = new Map(Array.from({ length: 15 }, (_, i) => [`m${i + 1}`, { id: `m${i + 1}` }]));
  return {
    queue: [], queueSeq: 0, mounts, markdown: new Map(), store: {}, signals: {}, wakeConsumers: consumers,
    wakeConsumerSeenAt: consumers ? Date.now() : 0, pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}
function raise200(state, bus) {
  const ids = [];
  for (let i = 0; i < 200; i++) {
    const mount = `m${(i % 15) + 1}`;
    if (i % 2) {
      const id = `c${100 + i}`;
      ids.push(id);
      queue.enqueueElement(state, bus, classify({ kind: 'comment', op: 'add', pin: { id, seq: i, shared: true, text: `pin ${i}`, anchor: { mount } } }).item);
    } else {
      const id = `h${100 + i}`;
      ids.push(id);
      queue.enqueueElement(state, bus, classify({ kind: 'element', type: 'highlight', op: 'add', id, v: 1, shared: true, mount }, { elementTypes: { highlight: { wake: true, label: 'Highlight' } } }).item);
    }
  }
  return ids;
}
const idsInContent = (content) => new Set(content.split('\n').flatMap((l) => {
  const tail = l.split(' in this group: ')[1];
  return tail ? tail.split(',') : [];
}));

test('C-14-1: 200 elements over 15 panes, two types, parked — the parked content names 200/200 element ids', () => {
  const state = cState(0);
  const bus = createBus();
  const ids = raise200(state, bus);
  assert.equal(state.queue.length, 30, 'one group per (type, pane)');
  const out = queue.flush(state, bus, {});
  assert.ok(out.parked, 'no channel: parked');
  const content = state.pendingWake.envelope.content;
  const named = idsInContent(content);
  assert.equal(ids.filter((id) => named.has(id)).length, 200, '200/200 in the content');
  assert.ok(content.includes(RESPOND_HINT));
});

test('C-14-1: live — bus.read({since: meta.seq − 1}) holds all 200 in the wake batch\'s element_ids', () => {
  const state = cState(1);
  const bus = createBus();
  const ids = raise200(state, bus);
  const out = queue.flush(state, bus, {});
  assert.ok(out.wake, 'a live wake');
  const { meta } = wakeEnvelope(out.wake.batch, { reason: out.wake.reason, source: out.wake.source, seq: out.wake.seq });
  const { events } = bus.read({ since: Number(meta.seq) - 1 });
  const wake = events.find((e) => e.kind === 'wake');
  const held = new Set(wake.batch.flatMap((it) => it.element_ids || []));
  assert.equal(ids.filter((id) => held.has(id)).length, 200);
});

// ── (9) the delivery-time excerpt gate (D2; notes-B D-6) ───────────────────

test('the delivery gate: an item queued with an excerpt while on, then off at Push → the wake batch, the envelope and a fresh park carry none; on at Push → one block', () => {
  let on = true;
  const raiseOne = (state, bus) => {
    const item = classify({ kind: 'element', type: 'highlight', op: 'add', id: 'h1', v: 1, shared: true, mount: 'm1' }, { elementTypes: { highlight: { wake: true, label: 'Highlight' } } }).item;
    queue.enqueueElement(state, bus, { ...item, excerpt: 'the passage' });
    queue.enqueueElement(state, bus, { ...item, element_id: 'h2', excerpt: 'another passage' });
  };
  for (const live of [1, 0]) {
    for (const atPush of [false, true]) {
      const state = cState(live);
      state.excerptsOn = () => on;
      const bus = createBus();
      on = true;
      raiseOne(state, bus);
      assert.ok(Array.isArray(state.queue[0].excerpt), 'queued while on: the group carries its excerpts');
      on = atPush;
      const out = queue.flush(state, bus, {});
      const batch = live ? out.wake.batch : state.pendingWake.batch;
      const content = live ? wakeEnvelope(batch).content : state.pendingWake.envelope.content;
      const what = `${live ? 'live' : 'park'}, ${atPush ? 'on' : 'off'} at Push`;
      if (atPush) {
        assert.equal(content.split(`${EXCERPT_HEADER}:`).length - 1, 1, `${what}: one block`);
        assert.ok(content.includes(`- highlight h1\n${EXCERPT_PREFIX}the passage`), `${what}: ${content}`);
      } else {
        assert.ok(batch.every((it) => !('excerpt' in it)), `${what}: the batch carries none`);
        assert.ok(!content.includes(EXCERPT_HEADER) && !content.includes('passage'), `${what}: ids-only`);
      }
    }
  }
  // A Retry (repush) and a reconnect's drain pass the gate too.
  const state = cState(1);
  state.excerptsOn = () => on;
  const bus = createBus();
  on = true;
  raiseOne(state, bus);
  const out = queue.flush(state, bus, {});
  assert.ok(out.wake.batch[0].excerpt, 'on: the wake carries it');
  on = false;
  const again = queue.repush(state, bus, out.wake.seq, {});
  assert.ok(again.wake.batch.every((it) => !('excerpt' in it)), 'repush after off: none');
  state.wakeConsumerSeenAt = 0;
  queue.foldPendingAck(state, bus);
  assert.ok(state.pendingWake.batch.every((it) => !('excerpt' in it)), 'the fold\'s fresh park: none');
  const drained = queue.drainPending(state, bus, null, {});
  assert.ok(drained.batch.every((it) => !('excerpt' in it)), 'drainPending: none');
  // A park stamped while on keeps its rendered envelope (the CLI says so);
  // a reconnect's drain of it after an off delivers ids-only.
  const parked = cState(0);
  parked.excerptsOn = () => on;
  on = true;
  raiseOne(parked, bus);
  queue.flush(parked, bus, {});
  assert.ok(parked.pendingWake.envelope.content.includes(EXCERPT_HEADER), 'stamped while on');
  on = false;
  assert.ok(parked.pendingWake.envelope.content.includes(EXCERPT_HEADER), 'kept as stamped until consumed or cancelled');
  parked.wakeConsumers = 1;
  parked.wakeConsumerSeenAt = Date.now();
  const late = queue.drainPending(parked, bus, null, {});
  assert.ok(late.batch.every((it) => !('excerpt' in it)), 'the drain after off: ids-only');
  // No switch at all (a bare state): off.
  assert.deepStrictEqual(queue.gateExcerpts({}, [{ id: 'q1', excerpt: 'x' }]), [{ id: 'q1' }]);
  const kept = [{ id: 'q1', excerpt: 'x' }];
  assert.strictEqual(queue.gateExcerpts({ excerptsOn: () => true }, kept), kept, 'on: the batch as it is');
  assert.deepStrictEqual(queue.gateExcerpts({ excerptsOn: () => { throw new Error('x'); } }, kept), [{ id: 'q1' }], 'a throw reads as off');
  assert.equal(kept[0].excerpt, 'x', 'the queue\'s items are never mutated');
});

// ── (10) through the daemon ─────────────────────────────────────────────────

const RANGE = (mount, exact) => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
async function bootPage(t, opts) {
  const d = await withServer(t, opts);
  await ok(d.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello the passage here</p>' }), 'render m1');
  await ok(d.api.post('/api/render', { id: 'm2', html: '<p class="lead">Hello the other passage</p>' }), 'render m2');
  return d;
}

test('a parked batch delivered whole: groups with excerpts plus two typed messages — one message held back, every group and the whole excerpt block in the park, consumed through GET /api/queue/pending + /consume', async (t) => {
  const { api, srv, root } = await bootPage(t);
  setSwitch(root, true);
  const hl = [];
  for (const [mount, exact] of [['m1', 'Hello'], ['m1', 'the passage'], ['m2', 'the other passage']]) {
    hl.push((await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE(mount, exact), payload: { color: 'gold', note: 'n' } }), 'highlight')).element);
  }
  const pin = (await ok(api.post('/api/elements', { type: 'comment', anchor: RANGE('m1', 'here'), payload: { text: 'why?', shared: true } }), 'pin')).element;
  // Two typed messages, staged for the Push (the composer's validated shape).
  for (const text of ['first typed', 'second typed']) {
    queue.enqueueMessage(srv.state, srv.bus, { text, skill: null, files: [], chars: text.length, conversation_id: null }, {});
  }
  const groups = srv.state.queue.filter((it) => it.kind === 'element');
  assert.deepStrictEqual(groups.map((g) => [g.type, g.origin_mount, g.count]), [['highlight', 'm1', 2], ['highlight', 'm2', 1], ['comment', 'm1', 1]]);
  const pushed = await ok(api.post('/api/queue/push', {}), 'push');
  assert.equal(pushed.mode, 'parked', JSON.stringify(pushed));
  assert.equal(srv.state.queue.filter((it) => it.kind === 'message').length, 1, 'parkHoldBack held back one message only');
  assert.equal(srv.state.queue.filter((it) => it.kind === 'element').length, 0, 'every group went');
  const pending = (await ok(api.get('/api/queue/pending'), 'pending')).pending;
  const content = pending.envelope.content;
  assert.equal(content.split(`${EXCERPT_HEADER}:`).length - 1, 1, 'one block');
  for (const [id, exact] of [[hl[0].id, 'Hello'], [hl[1].id, 'the passage'], [hl[2].id, 'the other passage'], [pin.id, 'here']]) {
    assert.ok(content.includes(`${id}\n${EXCERPT_PREFIX}${exact}`), `the block names ${id}: ${content}`);
  }
  assert.ok(content.includes(`2 in this group: ${hl[0].id},${hl[1].id}`), 'the group line names both');
  assert.ok(content.includes('> first typed') && !content.includes('> second typed'));
  assert.ok(content.includes(RESPOND_HINT));
  const consumed = await ok(api.post('/api/queue/pending/consume', { id: pending.id }), 'consume');
  assert.equal(consumed.consumed ?? consumed.ok, true, JSON.stringify(consumed));
  assert.equal((await ok(api.get('/api/queue/pending'), 'pending after')).pending, null);
});

test('Send to Claude raises the same item a share raises (summary, why_wake, respond, the excerpt under the switch)', async (t) => {
  const { api, srv, root } = await bootPage(t);
  setSwitch(root, true);
  const fields = (it) => ({ type: it.type, summary: it.summary, why_wake: it.why_wake, respond: it.respond, excerpt: it.excerpt, label: it.label });
  for (const body of [
    { type: 'comment', anchor: RANGE('m1', 'Hello'), payload: { text: 'a pin', shared: true } },
    { type: 'highlight', anchor: RANGE('m2', 'Hello'), payload: { color: 'gold', note: 'see' } },
  ]) {
    const el = (await ok(api.post('/api/elements', body), body.type)).element;
    const shared = groupOf(srv.state.queue, el.id);
    assert.ok(shared, `${body.type}: the share queued`);
    const want = fields(shared);
    assert.equal(typeof want.excerpt, 'string', `${body.type}: the excerpt under the switch`);
    await ok(api.del(`/api/queue/${shared.id}`), 'off the rail');
    const sent = await ok(api.post(`/api/elements/${el.id}/send`, { device: 'desktop' }), 'send');
    const item = groupOf(srv.state.queue, el.id);
    assert.equal(sent.item.id, item.id);
    assert.deepStrictEqual(fields(item), want, `${body.type}: a send raises what a share raises`);
  }
  // Off: a send raises no excerpt.
  setSwitch(root, false);
  const h = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE('m1', 'the passage'), payload: { note: 'x', shared: false } }), 'private')).element;
  await ok(api.post(`/api/elements/${h.id}/send`, { device: 'desktop' }), 'send off');
  const g = groupOf(srv.state.queue, h.id);
  assert.ok(g && !(Array.isArray(g.excerpt) ? g.excerpt.some((e) => e.id === h.id) : g.element_id === h.id && g.excerpt), 'off: no excerpt for it');
});

async function turn(api) {
  await api.post('/api/turn-begin', {});
  return ok(api.post('/api/turn-end', { author: 'claude', summary: 't' }), 'turn-end');
}

test('a node restore drops a removed pin\'s member and never a chat-comment member; a Wipe, a bulk clear and New graph never drop one either (WIPE@chat, O1 = a)', async (t) => {
  const { api, srv } = await bootPage(t);
  await turn(api);
  const n1 = (await ok(api.get('/api/graph'), 'graph')).active;
  const keep = (await ok(api.post('/api/elements', commentBody({ text: 'kept', shared: true, anchor: { mount: 'm2', selector: 'p', text: 'Hello', ordinal: 0 } })), 'pin m2')).pin;
  await turn(api);
  const pin = (await ok(api.post('/api/elements', commentBody({ text: 'gone', shared: true, anchor: { mount: 'm2', selector: 'p', text: 'Hello', ordinal: 0 } })), 'pin')).pin;
  const chat = addChat(srv, { text: 'chat words' });
  raiseChat(srv, chat);
  const pins = groupOf(srv.state.queue, pin.id);
  assert.deepStrictEqual(pins.element_ids, [keep.id, pin.id], 'both pins on m2 in one group');
  // n1 holds neither pin: the restore drops both members; the chat member stays.
  const nav = await ok(api.post('/api/graph/active', { id: n1 }), 'set active');
  assert.equal(nav.ok, true);
  await waitUntil(() => !groupOf(srv.state.queue, pin.id), { timeout: 5000, what: 'the restore\'s drop' });
  assert.equal(groupOf(srv.state.queue, keep.id), undefined);
  assert.ok(groupOf(srv.state.queue, chat.id), 'a chat-comment member survives a restore');
  await ok(api.post('/api/graph/wipe', {}), 'wipe');
  assert.ok(groupOf(srv.state.queue, chat.id), 'and a Wipe');
  await api.post('/api/clear', {});
  assert.ok(groupOf(srv.state.queue, chat.id), 'and a bulk clear');
  await ok(api.post('/api/graph/new', {}), 'new graph');
  assert.ok(groupOf(srv.state.queue, chat.id), 'and New graph');
  // Only its own Delete takes it (U415's drop; the chat route is U416's).
  assert.equal(removeElement(srv.state, srv.bus, chat.id, { elements: srv.elements }), true);
  assert.equal(groupOf(srv.state.queue, chat.id), undefined);
});

test('a node restore drops a highlight member the restored node does not reference, and keeps one it does (other page types by their element references)', async (t) => {
  const { api, srv } = await bootPage(t);
  const kept = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE('m1', 'Hello'), payload: { color: 'gold', note: 'kept' } }), 'kept')).element;
  await turn(api);
  const n1 = (await ok(api.get('/api/graph'), 'graph')).active;
  await ok(api.post('/api/render', { id: 'm3', html: '<p>a later node</p>' }), 'render m3');
  await turn(api);
  assert.notEqual((await ok(api.get('/api/graph'), 'graph')).active, n1, 'a later node is active');
  const gone = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE('m1', 'the passage'), payload: { color: 'gold', note: 'gone' } }), 'gone')).element;
  const g = groupOf(srv.state.queue, gone.id);
  assert.ok(g, 'the highlight queued');
  if (!g.element_ids.includes(kept.id)) queue.enqueueElement(srv.state, srv.bus, { ...g, id: undefined, element_id: kept.id, element_ids: [kept.id] });
  assert.deepStrictEqual(groupOf(srv.state.queue, gone.id).element_ids.slice().sort(), [kept.id, gone.id].sort(), 'both in one group');
  await ok(api.post('/api/graph/active', { id: n1 }), 'set active');
  await waitUntil(() => !groupOf(srv.state.queue, gone.id), { timeout: 5000, what: 'the restore\'s drop' });
  const left = groupOf(srv.state.queue, kept.id);
  assert.ok(left, 'the referenced highlight stays queued');
  assert.deepStrictEqual(left.element_ids, [kept.id]);
});

test('⟲ on a group deletes nothing: the row leaves the queue and every pin stays (RULED U423@group-revert Q2 = a)', async (t) => {
  const { api, srv } = await bootPage(t);
  const a = (await ok(api.post('/api/elements', commentBody({ text: 'a', shared: true, anchor: { mount: 'm1', selector: 'p', text: 'Hello', ordinal: 0 } })), 'a')).pin;
  const b = (await ok(api.post('/api/elements', commentBody({ text: 'b', shared: true, anchor: { mount: 'm1', selector: 'p', text: 'Hello', ordinal: 0 } })), 'b')).pin;
  const g = groupOf(srv.state.queue, a.id);
  assert.deepStrictEqual(g.element_ids, [a.id, b.id]);
  const r = await ok(api.del(`/api/queue/${g.id}?revert=1`), 'revert');
  assert.equal(r.reverted, false, 'nothing reverted');
  assert.equal(groupOf(srv.state.queue, a.id), undefined, 'the row left the queue');
  assert.deepStrictEqual(srv.state.comments.map((c) => c.id).sort(), [a.id, b.id].sort(), 'every pin stays');
});

test('a legacy kind \'comment\' item restored from an older draft: delivered with the hint, dequeued on its pin\'s delete, and its ⟲ deletes its pin', async (t) => {
  const first = await bootPage(t);
  const pins = [];
  for (const text of ['one', 'two', 'three']) {
    pins.push((await ok(first.api.post('/api/elements', commentBody({ text, shared: false, anchor: { mount: 'm1', selector: 'p', text: 'Hello', ordinal: 0 } })), text)).pin);
  }
  await turn(first.api);
  await first.graceful();
  const file = path.join(first.webChatDir, 'draft.json');
  const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  const legacy = (id, n) => ({ id: `q${900 + n}`, kind: 'comment', source: 'browser', comment_id: id, why_wake: 'comment pinned for Claude', summary: `m1 · "legacy ${n}"`, origin_mount: 'm1', seq: n, staged: true, enqueued_at: 1 });
  draft.queue = [legacy(pins[0].id, 0), legacy(pins[1].id, 1), legacy(pins[2].id, 2)];
  fs.writeFileSync(file, JSON.stringify(draft));

  const { api, srv } = await withServer(t, { root: first.root });
  assert.deepStrictEqual(srv.state.queue.map((it) => [it.kind, it.comment_id]), pins.map((p) => ['comment', p.id]), 'restored as written');
  // Dequeued on its pin's delete.
  await ok(api.del(`/api/elements/${pins[1].id}`), 'delete pin two');
  assert.deepStrictEqual(srv.state.queue.map((it) => it.comment_id), [pins[0].id, pins[2].id]);
  // Its ⟲ deletes its pin.
  const r = await ok(api.del('/api/queue/q902?revert=1'), 'revert');
  assert.equal(r.reverted, true);
  assert.ok(!srv.state.comments.some((c) => c.id === pins[2].id), 'the pin went');
  // Delivered with the hint.
  const pushed = await ok(api.post('/api/queue/push', {}), 'push');
  assert.equal(pushed.mode, 'parked');
  const content = (await ok(api.get('/api/queue/pending'), 'pending')).pending.envelope.content;
  assert.ok(content.includes('- [comment] m1 · "legacy 0"'), content);
  assert.ok(content.includes(RESPOND_HINT), 'the hint rides a legacy comment item');
});

// A parked group reads ×N on the rail (U582; spec H.2, QUEUE@group-row;
// corrective to U423/U424, whose hand-offs name it, and U460's open issue).
//
// GET /api/queue/pending projects each parked element item to the
// summary-only five plus the fields its rail card reads
// (lib/server/routes/queue.js ELEMENT_ITEM_FIELDS). Before this unit those
// were type, element_id, v and image alone, so a parked group of five comment
// pins drew as one 'Comment' row with no ×5, no members' ids and no respond
// dot. Now a group's `count`, `element_ids` (oldest → newest) and `respond`
// ride too, at every level — ids, a count and a boolean — while `members`,
// `more` and `excerpt` (text-bearing: TEXT_RULES.items.element) stay out of
// the parked row. A private pin never joins a queued group (J2), so its id
// never reaches a parked row either. (1) red at 503b8f2f.
const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert');
const path = require('path');
const { withServer, waitUntil, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { createBus } = require('../lib/core/bus');
const { classify, elementItem } = require('../lib/channel/policy');
const queue = require('../lib/server/domain/queue');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const WAIT = { timeout: 6000 };
const WORDS = 'wc-u582-pin-words-mark';
const PRIVATE = 'wc-u582-private-mark';
// What a parked element row may carry: the summary-only five, text_hidden,
// and the rail card's fields. Nothing text-bearing beyond `summary`.
const ROW_KEYS = new Set(['id', 'kind', 'summary', 'source', 'why_wake', 'text_hidden',
  'type', 'element_id', 'v', 'image', 'count', 'element_ids', 'respond']);

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// A daemon (its remote viewers opted in at `optIn`, or at nothing: basic), a
// pane, five shared comment pins on it — coalesced into one group — and one
// private pin, parked by a Push no channel takes. Returns the live group.
async function parkedGroup(t, optIn) {
  let seed;
  if (optIn) seed = (s) => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(s.root)]: optIn } } });
  const d = await withServer(t, seed ? { seed } : {});
  await ok(d.api.post('/api/render', { id: 'pg-a', html: '<p class="x">pane a</p>' }), 'render');
  const anchor = { mount: 'pg-a', selector: 'p.x', text: 'pane a', ordinal: 0 };
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const r = await ok(d.anonApi.post('/api/elements', commentBody({ text: `${WORDS} ${i}`, shared: true, anchor })), `pin ${i}`);
    ids.push(r.element.id);
  }
  const priv = (await ok(d.anonApi.post('/api/elements', commentBody({ text: PRIVATE, shared: false, anchor })), 'private pin')).element.id;
  const groups = d.srv.state.queue.filter((it) => it.kind === 'element');
  assert.equal(groups.length, 1, `precondition: one group (${JSON.stringify(groups.map((g) => g.element_ids))})`);
  const live = groups[0];
  assert.equal(live.count, 5, 'precondition: the live group counts five');
  assert.deepEqual(live.element_ids, ids, 'precondition: oldest → newest');
  assert.equal(live.respond, true, 'precondition: the comment type responds');
  assert.ok(Array.isArray(live.members) && live.members.length, 'precondition: the live group lists members');
  const pushed = await ok(d.api.post('/api/queue/push', {}), 'push');
  assert.equal(pushed.mode, 'parked', `the push parked: ${JSON.stringify(pushed)}`);
  return { d, ids, priv, live };
}

const rowOf = (pending, id) => {
  assert.ok(pending && Array.isArray(pending.items), 'a park is served');
  const row = pending.items.find((it) => it.id === id);
  assert.ok(row, `the parked row ${id}: ${JSON.stringify(pending.items)}`);
  return row;
};

function assertGroupRow(row, { ids, priv }, who) {
  assert.equal(row.kind, 'element', who);
  assert.equal(row.type, 'comment', who);
  assert.equal(row.count, 5, `${who}: the parked group counts five`);
  assert.deepEqual(row.element_ids, ids, `${who}: the five ids, oldest → newest`);
  assert.equal(row.element_id, ids[4], `${who}: the newest member`);
  assert.equal(row.respond, true, `${who}: respond`);
  assert.ok(!row.element_ids.includes(priv), `${who}: a private member never in a parked row`);
  assert.ok(!JSON.stringify(row).includes(priv), `${who}: the private pin's id nowhere in the row`);
  assert.ok(!JSON.stringify(row).includes(PRIVATE), `${who}: the private pin's words nowhere in the row`);
  for (const k of Object.keys(row)) assert.ok(ROW_KEYS.has(k), `${who}: no field beyond the rail's: ${k}`);
  for (const k of ['members', 'more', 'excerpt', 'label']) assert.equal(row[k], undefined, `${who}: no ${k}`);
}

// ── (1) the group's fields, at every level ──────────────────────────────────

test('(1) a parked group of five comment pins carries count 5, its five element_ids in order and respond true on GET /api/queue/pending — local, read and basic; no members, words or excerpt', async (t) => {
  const r = await parkedGroup(t, 'read');
  const local = (await ok(r.d.anonApi.get('/api/queue/pending'), 'local pending')).pending;
  assertGroupRow(rowOf(local, r.live.id), r, 'local');
  assert.ok(rowOf(local, r.live.id).summary.includes(WORDS), 'local: the summary still quotes the newest (unchanged)');
  const read = (await ok(r.d.anonApi.get('/api/queue/pending', REMOTE), 'remote pending at read')).pending;
  assertGroupRow(rowOf(read, r.live.id), r, 'read');

  const b = await parkedGroup(t, null);
  const basic = (await ok(b.d.anonApi.get('/api/queue/pending', REMOTE), 'remote pending at basic')).pending;
  const row = rowOf(basic, b.live.id);
  assertGroupRow(row, b, 'basic');
  assert.equal(row.text_hidden, true, 'basic: the row is text-free');
  assert.ok(!JSON.stringify(basic.items).includes(WORDS), 'basic: no member\'s words anywhere in the parked rows');
  // The stored park is not rewritten by the projection: its item keeps its members.
  const stored = b.d.srv.state.pendingWake.batch.find((it) => it.id === b.live.id);
  assert.ok(Array.isArray(stored.members) && stored.members.length, 'the stored park\'s item keeps its members');
});

// ── (2) a single item and a box grab ────────────────────────────────────────

// The route alone (the box-grab-chrome method: mounted on a recording app,
// judged as a local request) over a park holding `items`.
function parkedProjection(items, { remote = false } = {}) {
  const { mountQueueRoutes } = require('../lib/server/routes/queue');
  const handlers = {};
  const app = new Proxy({}, { get: (_, m) => (p, ...h) => { handlers[`${String(m).toUpperCase()} ${p}`] = h.at(-1); } });
  const state = { queue: [], pendingWake: { id: 'pw-1', created_at: 1, envelope: { meta: {} }, note: '', batch: items } };
  mountQueueRoutes(app, { state, bus: null, graph: null });
  let body = null;
  const headers = remote ? { 'x-wc-remote': '1' } : {};
  handlers['GET /api/queue/pending']({ query: {}, headers, socket: { remoteAddress: '127.0.0.1' } }, { json: (b) => { body = b; } });
  return body;
}

test('(2) a single highlight parked carries element_id, v and no count beyond what the live item carries; a box grab\'s image pointer is unchanged', () => {
  const hl = { id: 'q-h', ...elementItem({ type: 'highlight', id: 'h1', v: 3, mount: 'm1', shared: true }, { label: 'Highlight' }) };
  for (const remote of [false, true]) {
    const row = parkedProjection([hl], { remote }).pending.items[0];
    assert.equal(row.element_id, 'h1');
    assert.equal(row.v, 3);
    assert.equal(row.text_hidden, remote ? true : undefined, 'a remote request with no opt-in is judged basic');
    for (const k of ['members', 'more', 'excerpt']) assert.equal(row[k], undefined, `no ${k}`);
    for (const k of ['count', 'element_ids', 'respond']) {
      assert.deepEqual(row[k], hl[k], `${remote ? 'basic' : 'local'}: ${k} is the live item's (${JSON.stringify(hl[k])})`);
    }
  }
  const image = { state: 'ready', capture: 'cap7', path: 'captures/cap7.png', width: 40, height: 20 };
  const grab = { id: 'q-g', ...elementItem({ type: 'box-grab', id: 'g7', v: 1, mount: 'm1', image }, { label: 'Box grab' }) };
  for (const remote of [false, true]) {
    const row = parkedProjection([grab], { remote }).pending.items[0];
    assert.deepEqual(row.image, grab.image, `${remote ? 'basic' : 'local'}: the image pointer as the live item carries it`);
    assert.equal(row.element_id, 'g7');
  }
});

// ── (3) the rail reads ×5 on the parked row (jsdom) ─────────────────────────

const DECLS = { comment: { wake: { coalesce: 'count', respond: true }, label: 'Comment' } };
// Five shared comment pins raised through the policy and the queue domain as
// the daemon's dispatch raises them (lib/server/index.js): one group.
function fiveGroup() {
  const state = {
    queue: [], queueSeq: 0, mounts: new Map([['m1', { id: 'm1', gen: 0 }]]), markdown: new Map(), store: {},
    signals: {}, wakeConsumers: 0, wakeConsumerSeenAt: 0, pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
  const bus = createBus();
  for (let i = 1; i <= 5; i++) {
    const c = classify({ kind: 'comment', op: 'add', pin: { id: `c${i}`, seq: 1, shared: true, text: `note ${i}`, anchor: { mount: 'm1' } } },
      { elementTypes: DECLS });
    queue.enqueueElement(state, bus, { ...c.item, label: 'Comment' });
  }
  assert.equal(state.queue.length, 1, 'precondition: one group');
  return state.queue[0];
}

// The group's order is its own (oldest → newest by the last touch), never a
// sort: a member raised again becomes the newest, so c2 ends the list.
test('(2b) a parked group keeps its element_ids in the group\'s order, not sorted', () => {
  const state = {
    queue: [], queueSeq: 0, mounts: new Map([['m1', { id: 'm1', gen: 0 }]]), markdown: new Map(), store: {},
    signals: {}, wakeConsumers: 0, wakeConsumerSeenAt: 0, pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
  const bus = createBus();
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c2']) {
    const c = classify({ kind: 'comment', op: 'add', pin: { id, seq: 1, shared: true, text: `note ${id}`, anchor: { mount: 'm1' } } },
      { elementTypes: DECLS });
    queue.enqueueElement(state, bus, { ...c.item, label: 'Comment' });
  }
  const group = state.queue[0];
  assert.deepEqual(group.element_ids, ['c1', 'c3', 'c4', 'c5', 'c2'], 'precondition: the re-raised member is the newest');
  for (const remote of [false, true]) {
    const row = parkedProjection([group], { remote }).pending.items[0];
    assert.deepEqual(row.element_ids, ['c1', 'c3', 'c4', 'c5', 'c2'], `${remote ? 'basic' : 'local'}: the group's order`);
    assert.equal(row.count, 5);
    assert.equal(row.element_id, 'c2');
  }
});

// The real chrome, booted last in its own describe (the box-grab.test.js
// precedent): its globals would otherwise reach the daemons above.
describe('the rail over a parked group (jsdom)', () => {
  let shell, W, Q;
  let pendingBody = { pending: null };
  before(async () => {
    shell = await bootShell({
      routes: {
        '/api/queue': () => ({ items: [], count: 0 }),
        '/api/queue/pending': () => pendingBody,
        '/api/queue/*': () => ({ ok: true }),
        '/api/elements*': () => ({ ok: true, elements: [] }),
      },
    });
    W = shell.window;
    Q = await shell.importApp('queue.js');
    await shell.frame(helloFrame());
  });
  after(async () => { await shell.restore(); });

  test('(3) the rail drawn over that park reads the group\'s kind line with ×5 on the parked row, and its respond dot', async () => {
    const group = fiveGroup();
    pendingBody = parkedProjection([group], { remote: true });
    const parkedRow = () => W.document.querySelector(`#queue-rail .rail-item.parked[data-id="${group.id}"]`);
    try {
      await Q.refreshPending();
      await shell.tick();
      await waitUntil(() => parkedRow(), { ...WAIT, what: 'the parked row' });
      // queue.js loads toolbar-state.js lazily: until it lands the kind line
      // reads the type's name; the count is there either way.
      await waitUntil(() => /×5$/.test(parkedRow().querySelector('.qi-kind').textContent), { ...WAIT, what: 'the ×5' });
      assert.match(parkedRow().querySelector('.qi-kind').textContent, /^(Comment|comment) ×5$/);
      const dot = parkedRow().querySelector('.qi-dot');
      assert.ok(dot.classList.contains('qi-element') && dot.classList.contains('qi-comment'), dot.className);
      assert.ok(dot.classList.contains('qi-respond'), `the respond dot: ${dot.className}`);
    } finally {
      pendingBody = { pending: null };
      await Q.refreshPending();
      await shell.tick();
    }
  });
});

const test = require('node:test');
const assert = require('node:assert');
const { describeAnchor } = require('../lib/server/routes/comments');
const { withServer } = require('../test-support/helpers');

const anchor = (mount, text) => ({ mount, selector: 'button.go', text: text || 'Go', ordinal: 0 });
const render = (api, id) => api.post('/api/render', { id, html: '<button class="go">Go</button>' });

test('describeAnchor: human-readable forms', () => {
  assert.equal(describeAnchor({ mount: 'plan', text: 'Timeline' }), 'plan: "Timeline"');
  assert.equal(describeAnchor({ mount: 'plan', selector: 'button.go' }), 'plan @ button.go');
  assert.equal(describeAnchor({ mount: 'plan' }), 'plan (whole pane)');
  assert.equal(describeAnchor(null), null);
});

test('comments: add assigns id/seq, defaults shared:true, lives outside the store', async (t) => {
  const { api } = await withServer(t);
  const { post, get } = api;

  const r = (await post('/api/comments', { text: 'first', anchor: anchor('m1') })).json;
  assert.equal(r.ok, true);
  assert.equal(r.pin.shared, true);
  assert.equal(r.pin.id, 'c1');
  assert.equal(r.pin.seq, 1);

  assert.equal((await get('/api/comments')).json.comments.length, 1);
  // crucially NOT in the freeform store (which Claude reads via get_store)
  const store = (await get('/api/store')).json;
  assert.ok(!('__comments' in store));
  assert.ok(!('__comments_seq' in store));
});

test('comments: reply appends to the thread, bumps seq, rides get_comments with the hint', async (t) => {
  const { api } = await withServer(t);
  const { post, get } = api;
  await post('/api/comments', { text: 'too aggressive', shared: true, anchor: anchor('m1') }); // c1, seq 1

  const r = (await post('/api/comments/c1/reply', { text: 'shortened to 6 weeks', author: 'claude' })).json;
  assert.equal(r.ok, true);
  assert.equal(r.pin.replies.length, 1);
  assert.equal(r.pin.replies[0].author, 'claude');
  assert.equal(r.pin.replies[0].text, 'shortened to 6 weeks');
  assert.ok(r.pin.seq > 1, 'a reply bumps the pin seq so it re-surfaces to get_comments');

  const r2 = (await post('/api/comments/c1/reply', { text: 'keep a buffer' })).json; // default author → user
  assert.equal(r2.pin.replies.length, 2);
  assert.equal(r2.pin.replies[1].author, 'user');

  const shared = (await get('/api/comments?shared_only=1')).json;
  assert.equal(shared.comments[0].replies.length, 2, 'the whole thread rides get_comments');
  assert.match(shared.respond_hint, /respond-to-comment/); // C9: hint is top-level, not per pin
});

test('comments: reply validates — 404 unknown id, 400 empty text', async (t) => {
  const { api } = await withServer(t);
  const { post } = api;
  await post('/api/comments', { text: 'x', shared: true, anchor: anchor('m1') }); // c1
  assert.equal((await post('/api/comments/nope/reply', { text: 'hi' })).status, 404);
  assert.equal((await post('/api/comments/c1/reply', { text: '   ' })).status, 400);
});

test('comments: a private pin never enters the store (no get_store leak)', async (t) => {
  const { api } = await withServer(t);
  const { post, get } = api;

  await post('/api/comments', { text: 'TOP-SECRET-NOTE', shared: false, anchor: anchor('m1') });
  const store = (await get('/api/store')).json;
  assert.equal(JSON.stringify(store).includes('TOP-SECRET-NOTE'), false, 'private text must not be reachable via the store');
  // but it IS retrievable on the browser-facing (unfiltered) comments read
  assert.equal((await get('/api/comments')).json.comments.length, 1);
  // and withheld from the shared-only (Claude) read
  assert.equal((await get('/api/comments?shared_only=1')).json.comments.length, 0);
});

test('comments: shared_only withholds private pins; next_cursor spans the full array', async (t) => {
  const { api } = await withServer(t);
  const { post, get } = api;

  await post('/api/comments', { text: 'a', shared: true, anchor: anchor('m1') });   // seq 1
  await post('/api/comments', { text: 'b', shared: false, anchor: anchor('m1') });  // seq 2 (private)
  await post('/api/comments', { text: 'c', shared: true, anchor: anchor('m2') });   // seq 3

  const all = (await get('/api/comments')).json;
  assert.equal(all.comments.length, 3);
  assert.equal(all.next_cursor, 3);

  const shared = (await get('/api/comments?shared_only=1')).json;
  assert.deepEqual(shared.comments.map((c) => c.text), ['a', 'c']);
  assert.equal(shared.next_cursor, 3, 'cursor spans the full array incl. the private seq 2');
  assert.ok(shared.comments[0].anchor_label, 'resolved anchor label present');
});

test('comments: since cursor and mount filter', async (t) => {
  const { api } = await withServer(t);
  const { post, get } = api;

  await post('/api/comments', { text: 'a', anchor: anchor('m1') }); // seq1
  await post('/api/comments', { text: 'b', anchor: anchor('m2') }); // seq2
  await post('/api/comments', { text: 'c', anchor: anchor('m1') }); // seq3

  assert.deepEqual((await get('/api/comments?shared_only=1&since=2')).json.comments.map((c) => c.text), ['c']);
  assert.deepEqual((await get('/api/comments?shared_only=1&mount=m1')).json.comments.map((c) => c.text), ['a', 'c']);
});

test('comments: toggling shared re-stamps seq; a no-op PATCH does not', async (t) => {
  const { api } = await withServer(t);
  const { post, patch, get } = api;

  await post('/api/comments', { text: 'a', shared: true, anchor: anchor('m1') });   // seq1
  const b = (await post('/api/comments', { text: 'b', shared: false, anchor: anchor('m1') })).json.pin; // seq2

  // a no-op PATCH (already private) must not bump the cursor
  const noop = await patch('/api/comments/' + b.id, { shared: false });
  assert.equal(noop.json.unchanged, true);
  assert.equal(noop.json.pin.seq, 2);

  // Claude has caught up to cursor 2 and seen only the shared 'a'
  assert.deepEqual((await get('/api/comments?shared_only=1&since=2')).json.comments.map((c) => c.text), []);

  // while private, 'b' is NOT in the wake queue
  assert.equal((await get('/api/queue')).json.items.some((it) => it.comment_id === b.id), false);

  // toggling 'b' to shared re-stamps seq → resurfaces past cursor 2
  const upd = await patch('/api/comments/' + b.id, { shared: true });
  assert.ok(upd.json.pin.seq > 2);
  assert.deepEqual((await get('/api/comments?shared_only=1&since=2')).json.comments.map((c) => c.text), ['b']);

  // ...and the toggle enqueues it for the wake rail — a private→shared flip is a
  // deliberate handoff, same as an add (the bug: this used to silently drop)
  const bItem = (await get('/api/queue')).json.items.find((it) => it.comment_id === b.id);
  assert.ok(bItem, 'toggling b to shared enqueues it');
  assert.equal(bItem.kind, 'comment');

  // re-unchecking "share w/ Claude" (shared→private) drops it back off the rail
  await patch('/api/comments/' + b.id, { shared: false });
  assert.equal((await get('/api/queue')).json.items.some((it) => it.comment_id === b.id), false, 'un-sharing b removes it from the queue');
});

test('comments: deleting a shared pin clears its item from the wake queue', async (t) => {
  const { api } = await withServer(t);
  const { post, del, get } = api;

  const a = (await post('/api/comments', { text: 'a', shared: true, anchor: anchor('m1') })).json.pin;
  assert.ok((await get('/api/queue')).json.items.some((it) => it.comment_id === a.id), 'a shared add enqueues');

  await del('/api/comments/' + a.id);
  assert.equal((await get('/api/queue')).json.items.some((it) => it.comment_id === a.id), false, 'deleting the pin clears its queue item');
});

test('comments: delete removes the pin; 404 on unknown id', async (t) => {
  const { api } = await withServer(t);
  const { post, del, get } = api;

  const a = (await post('/api/comments', { text: 'a', anchor: anchor('m1') })).json.pin;
  assert.equal((await del('/api/comments/' + a.id)).status, 200);
  assert.equal((await get('/api/comments')).json.comments.length, 0);
  assert.equal((await del('/api/comments/nope')).status, 404);
});

test('comments: pins persist into node.comments and survive restart', async (t) => {
  const { api, root, graceful } = await withServer(t);

  await render(api, 'm1');
  await api.post('/api/comments', { text: 'survive me', shared: false, anchor: anchor('m1') });
  await api.post('/api/turn-begin', {});
  const end = (await api.post('/api/turn-end', { summary: 't' })).json;
  assert.ok(end.node_id);

  await graceful();

  const { api: api2 } = await withServer(t, { root });
  const node = (await api2.get('/api/graph/node/' + end.node_id)).json;
  assert.ok(Array.isArray(node.comments));
  assert.equal(node.comments[0].text, 'survive me');
  assert.equal(node.comments[0].shared, false, 'private flag preserved across restart');
  // and it stayed out of the persisted store
  assert.ok(!node.store || !('__comments' in node.store));
});

test('comments: seq stays globally unique after navigating to an earlier node', async (t) => {
  const { api } = await withServer(t);
  const { post } = api;

  await render(api, 'm1');
  await post('/api/comments', { text: 'A', anchor: anchor('m1') });            // seq1
  await post('/api/turn-begin', {});
  const n0 = (await post('/api/turn-end', { summary: 't' })).json.node_id;

  await render(api, 'm2');
  await post('/api/comments', { text: 'B', anchor: anchor('m2') });            // seq2
  await post('/api/turn-begin', {});
  await post('/api/turn-end', { summary: 't' });

  // navigate back to the earlier node and add a pin there
  const nav = (await post('/api/graph/active', { id: n0 })).json;
  assert.equal(nav.ok, true);
  const c = (await post('/api/comments', { text: 'C', anchor: anchor('m1') })).json.pin;

  // must NOT reuse seq2/id c2 even though n0's recorded counter was lower
  assert.equal(c.seq, 3, 'global counter is not reset by navigation');
  assert.equal(c.id, 'c3');
});

test('comments: private-pin add/edit/reply events carry no text but keep id+shared (F1)', async (t) => {
  const { api } = await withServer(t);
  const { post, patch, get } = api;

  const p = (await post('/api/comments', { text: 'SECRET-ADD', shared: false, anchor: anchor('m1') })).json.pin;
  await patch('/api/comments/' + p.id, { text: 'SECRET-EDIT' });            // still private
  await post('/api/comments/' + p.id + '/reply', { text: 'SECRET-REPLY' }); // user reply (allowed)

  // GET /api/events serves the ring unfiltered — the exact leak F1 closes.
  const evs = (await get('/api/events')).json.events.filter((e) => e.kind === 'comment');
  const raw = JSON.stringify(evs);
  assert.equal(raw.includes('SECRET-ADD'), false, 'private add text must not reach the event ring');
  assert.equal(raw.includes('SECRET-EDIT'), false, 'private edit text must not reach the event ring');
  assert.equal(raw.includes('SECRET-REPLY'), false, 'private reply text must not reach the event ring');

  // ...but the metadata lib/channel/policy reads on the dequeue path survives.
  const withPin = evs.filter((e) => e.pin);
  assert.ok(withPin.length >= 3, 'add/edit/reply each still carry a pin');
  for (const e of withPin) {
    assert.equal(e.pin.id, p.id, 'pin id kept');
    assert.equal(e.pin.shared, false, 'pin shared flag kept');
    assert.equal(e.pin.text, '', 'note body redacted');
    for (const r of (e.pin.replies || [])) assert.equal(r.text, '', 'reply body redacted');
  }
});

test('comments: Claude cannot reply into a private thread (F2 — 404, nothing stored)', async (t) => {
  const { api } = await withServer(t);
  const { post, get } = api;
  const p = (await post('/api/comments', { text: 'private', shared: false, anchor: anchor('m1') })).json.pin;

  // 404 (not 403) so an enumerable id can't be probed for existence.
  const claude = await post('/api/comments/' + p.id + '/reply', { text: 'sneaky', author: 'claude' });
  assert.equal(claude.status, 404);
  const after = (await get('/api/comments')).json.comments.find((c) => c.id === p.id);
  assert.ok(!after.replies || after.replies.length === 0, 'no claude reply was appended');

  // a user reply from the browser stays allowed on the same private pin
  const user = await post('/api/comments/' + p.id + '/reply', { text: 'my own note' });
  assert.equal(user.status, 200);
  assert.equal(user.json.pin.replies.length, 1);
  assert.equal(user.json.pin.replies[0].author, 'user');
});

test('comments: un-share edit stamps became_private on the event (B7)', async (t) => {
  const { api } = await withServer(t);
  const { post, patch, get } = api;
  const p = (await post('/api/comments', { text: 'a', shared: true, anchor: anchor('m1') })).json.pin;
  await patch('/api/comments/' + p.id, { shared: false });

  const editEv = (await get('/api/events')).json.events
    .filter((e) => e.kind === 'comment' && e.op === 'edit').pop();
  assert.ok(editEv, 'an edit event was emitted');
  assert.equal(editEv.became_private, true);
  assert.equal(editEv.became_shared, false);
});

test('comments: respond_hint is one top-level field, not stamped per pin (C9)', async (t) => {
  const { api } = await withServer(t);
  const { post, get } = api;
  await post('/api/comments', { text: 'a', shared: true, anchor: anchor('m1') });
  await post('/api/comments', { text: 'b', shared: true, anchor: anchor('m2') });

  const r = (await get('/api/comments?shared_only=1')).json;
  assert.match(r.respond_hint, /respond-to-comment/, 'hint rides the top-level response');
  assert.equal(r.comments.length, 2);
  for (const c of r.comments) assert.ok(!('respond_hint' in c), 'not stamped per pin');
});

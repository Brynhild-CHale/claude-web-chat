// The park's note order (H.3, U583). U401's hand-off saw, with an unacked
// wake retained, a second Push's "next wake" carry the EARLIER Push's note.
// The rule the queue is held to here: every wake it emits — live, drained,
// re-pushed or the park's — carries the note of the push whose batch it
// carries. A park that MERGES several pushes keeps its documented rule: the
// latest non-blank note re-stamps, a note-less re-push keeps the parked note
// (RULED U583@merged-park-note (a)), so a merged park drops the earlier note.
//
// What U401 read: a host `kinds=wake` stream is a wake consumer, and its
// connect runs drainPending, which first folds the retained in-flight wake
// into the park and then drains the park as a wake — before the new Push is
// made. That drained wake is the fold's redelivery of the earlier batch, with
// that batch's own note (or, when the park merged, the documented latest
// one). These tests reproduce it through the domain and through the routes.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, commentBody, openSSE, waitUntil } = require('../test-support/helpers');
const { createBus } = require('../lib/core/bus');
const { post } = require('../lib/client');
const queue = require('../lib/server/domain/queue');

const N1 = 'wc-u583-push-note-alpha';
const N2 = 'wc-u583-push-note-bravo';
const N3 = 'wc-u583-push-note-charlie';
const PID = 4242;

function liveState() {
  return {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: 1, wakeConsumerSeenAt: Date.now(), pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}

const wakesOf = (bus) => bus.read({ since: 0, kinds: ['wake'] }).events;
const isBlank = (n) => n == null || String(n).trim() === '';
const idsOf = (batch) => (Array.isArray(batch) ? batch : []).map((it) => it.id);

// Every ring wake's note belongs to the push whose batch it carries:
// `owner` maps an item id to its push's note. A wake whose batch spans
// several pushes (a merged park's drain) carries the latest non-blank of their
// notes (`merged`, in push order), the documented rule.
function assertNotesOwned(wakes, owner, pushOrder, what) {
  for (const w of wakes) {
    const ids = idsOf(w.batch);
    assert.ok(ids.every((id) => owner.has(id)), `${what}: wake seq ${w.seq} carries an item no push sent: ${ids}`);
    const notes = [...new Set(ids.map((id) => owner.get(id)))];
    if (notes.length <= 1) {
      assert.strictEqual(w.note, isBlank(notes[0]) ? undefined : notes[0], `${what}: wake seq ${w.seq} (batch ${ids}) carries its own push's note`);
    } else {
      const latest = pushOrder.filter((n) => notes.includes(n) && !isBlank(n)).at(-1);
      assert.strictEqual(w.note, latest, `${what}: wake seq ${w.seq} (merged batch ${ids}) carries the latest non-blank note`);
    }
  }
}

// Push `note` with one fresh signal item; answers [item id, flush result].
function pushOne(state, bus, summary, note, owner) {
  const item = queue.enqueue(state, bus, { kind: 'signal', summary });
  owner.set(item.id, note);
  return [item.id, queue.flush(state, bus, { note })];
}

// ── domain ───────────────────────────────────────────────────────────────

test('a live channel that never acks: push 2 folds batch 1 into the park with n1, and its live wake carries n2 and batch 2 only', () => {
  const bus = createBus({ bootId: 'b1' });
  const state = liveState();
  const owner = new Map();
  queue.stampChannel(state, PID);
  const [id1, r1] = pushOne(state, bus, 's1', N1, owner);
  assert.ok(r1.wake, 'push 1 woke the live channel');
  assert.strictEqual(r1.wake.note, N1);
  assert.deepStrictEqual(idsOf(r1.wake.batch), [id1]);
  assert.strictEqual(state.pendingAck.seq, r1.wake.seq, 'wake 1 retained (never acked)');
  assert.strictEqual(state.pendingAck.note, N1, 'the retain holds its own note');

  queue.stampChannel(state, PID); // a heartbeat keeps the channel live
  const [id2, r2] = pushOne(state, bus, 's2', N2, owner);
  assert.ok(r2.wake, 'push 2 woke the live channel');
  assert.strictEqual(r2.wake.note, N2, 'the live wake carries push 2\'s note');
  assert.deepStrictEqual(idsOf(r2.wake.batch), [id2], 'and push 2\'s batch only');
  assert.ok(state.pendingWake, 'the fold parked the retained wake');
  assert.deepStrictEqual(idsOf(state.pendingWake.batch), [id1], 'the park holds batch 1');
  assert.strictEqual(state.pendingWake.note, N1, 'with batch 1\'s note');
  assert.ok(state.pendingWake.envelope.content.includes(N1) && !state.pendingWake.envelope.content.includes(N2), 'the park\'s envelope quotes n1, never n2');
  assert.strictEqual(state.pendingAck.note, N2, 'wake 2 retained with its own note');

  const wakes = wakesOf(bus);
  assert.strictEqual(wakes.length, 2, 'two wakes on the ring');
  assertNotesOwned(wakes, owner, [N1, N2], 'live');
});

test('the parked batch 1 drains with n1 on a reconnect (wake 2 acked) and is served with n1 on turn-begin\'s read', () => {
  const bus = createBus({ bootId: 'b1' });
  const state = liveState();
  const owner = new Map();
  const [id1] = pushOne(state, bus, 's1', N1, owner);
  queue.stampChannel(state, PID);
  const [, r2] = pushOne(state, bus, 's2', N2, owner);

  // turn-begin's read (GET /api/queue/pending's domain half): the retain is
  // fresh, so foldStaleAck leaves it; the park served is batch 1 with n1.
  assert.strictEqual(queue.foldStaleAck(state, Date.now(), bus), false, 'a fresh retain is not folded');
  const served = queue.pendingFor(state, null);
  assert.deepStrictEqual(idsOf(served.batch), [id1]);
  assert.strictEqual(served.note, N1, 'turn-begin reads n1 with batch 1');

  assert.strictEqual(queue.ackWake(state, bus, r2.wake.seq, r2.wake.boot), true, 'wake 2 acked on a live channel');
  const drained = queue.drainPending(state, bus, null);
  assert.ok(drained, 'the reconnect drained the park');
  assert.deepStrictEqual(idsOf(drained.batch), [id1], 'the drained wake carries batch 1');
  assert.strictEqual(drained.note, N1, 'with n1, never n2');
  assert.strictEqual(state.pendingAck.note, N1, 'the drained wake is retained with its own note');
  assertNotesOwned(wakesOf(bus), owner, [N1, N2], 'drained');
});

test('a drain owed to a pid (drainForChannel) carries the park\'s own note once the in-flight wake clears', () => {
  const bus = createBus({ bootId: 'b1' });
  const state = liveState();
  const owner = new Map();
  const [id1] = pushOne(state, bus, 's1', N1, owner);
  const [, r2] = pushOne(state, bus, 's2', N2, owner);
  const turned = queue.stampChannel(state, PID);
  assert.strictEqual(queue.drainForChannel(state, bus, null, PID, { turnedLive: turned.turnedLive }), null, 'blocked by the in-flight wake, owed');
  queue.ackWake(state, bus, r2.wake.seq, r2.wake.boot);
  queue.stampChannel(state, PID);
  const drained = queue.drainForChannel(state, bus, null, PID);
  assert.ok(drained, 'the owed drain is made');
  assert.deepStrictEqual(idsOf(drained.batch), [id1]);
  assert.strictEqual(drained.note, N1);
  assertNotesOwned(wakesOf(bus), owner, [N1, N2], 'owed drain');
});

test('U401\'s shape: a reconnect with wake 2 still unacked folds it into the park, and the drained wake is the merged park (the documented rule: n2, n1 dropped) — before push 3, whose wake carries n3', () => {
  const bus = createBus({ bootId: 'b1' });
  const state = liveState();
  const owner = new Map();
  const [id1] = pushOne(state, bus, 's1', N1, owner);
  const [id2] = pushOne(state, bus, 's2', N2, owner);
  const drained = queue.drainPending(state, bus, null); // a wake consumer connects
  assert.deepStrictEqual(idsOf(drained.batch), [id1, id2], 'the merged park: batch 1 then batch 2');
  assert.strictEqual(drained.note, N2, 'the latest non-blank note re-stamps (U583@merged-park-note (a))');
  const [id3, r3] = pushOne(state, bus, 's3', N3, owner);
  assert.deepStrictEqual(idsOf(r3.wake.batch), [id3]);
  assert.strictEqual(r3.wake.note, N3, 'push 3\'s wake carries n3');
  // The fold parked the drained (merged) wake again, with ITS note.
  assert.deepStrictEqual(idsOf(state.pendingWake.batch), [id1, id2]);
  assert.strictEqual(state.pendingWake.note, N2);
  assertNotesOwned(wakesOf(bus), owner, [N1, N2, N3], 'U401 shape');
});

test('a stale-ack fold (foldStaleAck) and a repush keep the retained wake\'s own note', () => {
  // foldStaleAck: wake 1 ages out → the park holds batch 1 with n1.
  {
    const bus = createBus({ bootId: 'b1' });
    const state = liveState();
    const owner = new Map();
    const [id1, r1] = pushOne(state, bus, 's1', N1, owner);
    assert.strictEqual(queue.foldStaleAck(state, Date.now() + queue.ACK_STALE_MS + 1_000, bus), true, 'aged out, folded');
    assert.deepStrictEqual(idsOf(state.pendingWake.batch), [id1]);
    assert.strictEqual(state.pendingWake.note, N1, 'the stale fold parks n1');
    // A later live push: its own note; the fold-made park keeps n1.
    queue.stampChannel(state, PID);
    const [id2, r2] = pushOne(state, bus, 's2', N2, owner);
    assert.deepStrictEqual(idsOf(r2.wake.batch), [id2]);
    assert.strictEqual(r2.wake.note, N2);
    assert.strictEqual(state.pendingWake.note, N1, 'the park keeps n1 (nothing was retained to fold)');
    assertNotesOwned(wakesOf(bus), owner, [N1, N2], 'stale fold');
  }
  // repush: Retry re-emits the retained batch with its note; Hold parks it with its note.
  {
    const bus = createBus({ bootId: 'b1' });
    const state = liveState();
    const owner = new Map();
    pushOne(state, bus, 's1', N1, owner);
    const [id2, r2] = pushOne(state, bus, 's2', N2, owner);
    const retry = queue.repush(state, bus, r2.wake.seq, {});
    assert.strictEqual(retry.mode, 'wake');
    assert.deepStrictEqual(idsOf(retry.wake.batch), [id2], 'the retry re-sends batch 2');
    assert.strictEqual(retry.wake.note, N2, 'with n2');
    assert.strictEqual(state.pendingWake.note, N1, 'the park (batch 1) keeps n1');
    const hold = queue.repush(state, bus, retry.wake.seq, { park: true });
    assert.strictEqual(hold.mode, 'parked');
    assert.strictEqual(hold.parked.note, N2, 'Hold merges batch 2 into the park: the latest non-blank note (n2) re-stamps');
    assertNotesOwned(wakesOf(bus), owner, [N1, N2], 'repush');
  }
});

test('no live channel: both pushes park and merge; the merged park holds both batches and its note follows the documented rule; a note-less re-push keeps it', () => {
  const bus = createBus({ bootId: 'b1' });
  const state = liveState();
  state.wakeConsumers = 0;
  const owner = new Map();
  const [id1, r1] = pushOne(state, bus, 's1', N1, owner);
  assert.strictEqual(r1.wake, null);
  assert.strictEqual(r1.parked.note, N1);
  const [id2, r2] = pushOne(state, bus, 's2', N2, owner);
  assert.strictEqual(r2.wake, null);
  assert.deepStrictEqual(idsOf(r2.parked.batch), [id1, id2], 'one park, both batches');
  assert.strictEqual(r2.parked.note, N2, 'the latest non-blank note re-stamps');
  assert.ok(r2.parked.envelope.content.includes(N2) && !r2.parked.envelope.content.includes(N1), 'the envelope quotes n2 (n1 is the documented drop)');
  for (const blank of [undefined, '', '   ']) {
    const [, r] = pushOne(state, bus, `s-${String(blank)}`, blank, owner);
    assert.strictEqual(r.wake, null);
    assert.strictEqual(r.parked.note, N2, `a re-push with note ${JSON.stringify(blank)} keeps the parked note`);
  }
  assert.strictEqual(wakesOf(bus).length, 0, 'nothing woke');
  // The channel comes up: the merged park drains as one wake with the merged note.
  state.wakeConsumers = 1;
  queue.stampChannel(state, PID);
  const drained = queue.drainPending(state, bus, null);
  assert.strictEqual(drained.note, N2);
  assert.strictEqual(idsOf(drained.batch).length, 5, 'every parked item drains');
  assertNotesOwned(wakesOf(bus), owner, [N1, N2, undefined, '', '   '], 'merged park');
});

// ── routes ───────────────────────────────────────────────────────────────

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.json)}`);
  return r.json;
}

// A shared pin on its own pane queues one comment item; answers its id.
async function pin(d, n) {
  const mount = `wn-pane-${n}`;
  await ok(d.api.post('/api/render', { id: mount, html: `<p class="lead">Hello ${n}</p>` }), `render ${n}`);
  await ok(d.api.post('/api/elements', commentBody({ text: `pin ${n}`, shared: true, anchor: { mount, selector: 'p.lead', text: 'Hello', ordinal: 0 } })), `pin ${n}`);
  const items = (await ok(d.api.get('/api/queue'), 'queue')).items;
  assert.strictEqual(items.length, 1, `pin ${n}: one item queued: ${JSON.stringify(items)}`);
  return items[0].id;
}

const ringWakes = async (d) => (await ok(d.api.get('/api/events?since=0'), 'events')).events.filter((e) => e.kind === 'wake');

test('routes: two noted Pushes into a channel that never acks — each ring wake carries its own batch\'s note; turn-begin reads n1; a reconnect drains batch 1 with n1', async (t) => {
  const d = await withServer(t);
  const channel = await openSSE(d.port, { kinds: ['wake'], awaitChannel: d.api });
  t.after(() => channel.close());
  const owner = new Map();

  const item1 = await pin(d, 1);
  owner.set(item1, N1);
  const p1 = await ok(d.api.post('/api/queue/push', { note: N1 }), 'push 1');
  assert.strictEqual(p1.mode, 'wake', `push 1 woke: ${JSON.stringify(p1)}`);
  await waitUntil(() => channel.events.filter((e) => e.kind === 'wake').length >= 1, { timeout: 5000, what: 'wake 1' });

  // The channel routes are host-only: the bridge posts through lib/client.
  const host = { port: d.port, noSpawn: true };
  assert.strictEqual((await post('/api/channel/heartbeat', {}, host)).ok, true, 'heartbeat');
  const item2 = await pin(d, 2);
  owner.set(item2, N2);
  const p2 = await ok(d.api.post('/api/queue/push', { note: N2 }), 'push 2');
  assert.strictEqual(p2.mode, 'wake', `push 2 woke: ${JSON.stringify(p2)}`);
  await waitUntil(() => channel.events.filter((e) => e.kind === 'wake').length >= 2, { timeout: 5000, what: 'wake 2' });

  const live = channel.events.filter((e) => e.kind === 'wake');
  assert.deepStrictEqual(live.map((e) => [idsOf(e.batch), e.note]), [[[item1], N1], [[item2], N2]], 'the channel read each wake with its own batch and note');
  const ring = await ringWakes(d);
  assert.strictEqual(ring.length, 2);
  assertNotesOwned(ring, owner, [N1, N2], 'routes, live');

  // turn-begin's read: the park left by the fold is batch 1 with n1.
  const pending = (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
  assert.ok(pending, 'a park waits');
  assert.deepStrictEqual(pending.items.map((it) => it.id), [item1]);
  assert.strictEqual(pending.note, N1, 'turn-begin reads n1, never n2');
  assert.ok(pending.envelope.content.includes(N1) && !pending.envelope.content.includes(N2), 'the served envelope quotes n1 only');

  // Wake 2 is acked; a reconnecting bridge drains batch 1 with n1.
  const acked = await post('/api/channel/ack', { seq: live[1].seq, boot: live[1].boot }, host);
  assert.strictEqual(acked.acked, true);
  const again = await openSSE(d.port, { kinds: ['wake'] });
  t.after(() => again.close());
  await waitUntil(() => again.events.some((e) => e.kind === 'wake'), { timeout: 5000, what: 'the drained wake' });
  const drained = again.events.find((e) => e.kind === 'wake');
  assert.deepStrictEqual(idsOf(drained.batch), [item1], 'the drain carries batch 1');
  assert.strictEqual(drained.note, N1, 'with n1');
  assertNotesOwned(await ringWakes(d), owner, [N1, N2], 'routes, drained');
});

test('routes: U401\'s read — a host wake stream connecting with wake 2 unacked gets the merged park\'s redelivery first (n2 by the documented rule), then push 3\'s wake with n3', async (t) => {
  const d = await withServer(t);
  const channel = await openSSE(d.port, { kinds: ['wake'], awaitChannel: d.api });
  t.after(() => channel.close());
  const owner = new Map();
  for (const [n, note] of [[1, N1], [2, N2]]) {
    const id = await pin(d, n);
    owner.set(id, note);
    const r = await ok(d.api.post('/api/queue/push', { note }), `push ${n}`);
    assert.strictEqual(r.mode, 'wake');
  }
  await waitUntil(() => channel.events.filter((e) => e.kind === 'wake').length >= 2, { timeout: 5000, what: 'two wakes' });
  const head = (await ok(d.api.get('/api/events?since=0'), 'events')).events.at(-1).seq;
  const stream = await openSSE(d.port, { kinds: ['wake'], since: head });
  t.after(() => stream.close());
  const id3 = await pin(d, 3);
  owner.set(id3, N3);
  const r3 = await ok(d.api.post('/api/queue/push', { note: N3 }), 'push 3');
  assert.strictEqual(r3.mode, 'wake');
  await waitUntil(() => stream.events.filter((e) => e.kind === 'wake').length >= 2, { timeout: 5000, what: 'the redelivery and wake 3' });
  const [first, second] = stream.events.filter((e) => e.kind === 'wake');
  assert.deepStrictEqual(idsOf(first.batch), [...owner.keys()].slice(0, 2), 'the first wake the new stream reads is the fold\'s redelivery of batches 1 and 2');
  assert.strictEqual(first.note, N2, 'its note: the merged park\'s, the latest non-blank (n1 the documented drop)');
  assert.deepStrictEqual(idsOf(second.batch), [id3]);
  assert.strictEqual(second.note, N3, 'push 3\'s wake carries n3');
  assertNotesOwned(await ringWakes(d), owner, [N1, N2, N3], 'routes, U401');
});

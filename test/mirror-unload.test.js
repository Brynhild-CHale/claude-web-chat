// Unloading a conversation and the parsed-conversation budget (annotation engine
// PLAN.md 3E.2 part 1 and 3E.4's number; DECISIONS.md K.2-158; ruled
// REQ@parsed-index-budget, U452@parsed-ram-bytes).
//
// Pinned, through a real facade (createMirror) whose `transcripts` source is a
// fake registered through the `sources` seam, over a temp project (the real
// createIndexStore where the index is written):
//   * an unload is silent: the conversation's turns and items leave the model,
//     no turn, item, removed or reset frame (nor a ring event) goes out for it,
//     and the conversation stays in snapshot() with the turn count it held;
//   * restoreTurns of the entries exported before brings back the same turn ids
//     and seqs; unloadedConversationOf answers the conversation until then, null
//     after; an unknown conversation answers false;
//   * the turn machine refuses while the conversation holds an open turn or a
//     pending (closed, unattached) one; a `replaces` alias resolves again after
//     the re-open;
//   * the budget evicts the least recently used conversation that is not
//     pinned: never the touched one, an eager one (api.pinned) or one holding a
//     pending turn; a transcripts dispatch is a use;
//   * sources hear `unloaded` before the turns leave: a debounced index write
//     flushed in that hook is on disk with every turn (R1);
//   * with no api.pinned on the transcripts source nothing is unloaded (the real
//     transcripts.js has none at this head);
//   * engine.ensureConversation and engine.indexing route to the source's api;
//   * the number: floor(PARSED_RAM_BYTES / 416,958 B) = 160, never below 20.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { waitUntil } = require('../test-support/helpers');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { createMirror, PARSED_RAM_BYTES, PARSED_CONVERSATIONS_MAX } = require('../lib/server/mirror');
const { createModel } = require('../lib/server/mirror/model');
const { createTurnMachine } = require('../lib/server/mirror/turn-machine');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const { createIndexStore, DEBOUNCE_MS } = require('../lib/server/mirror/index-store');
const { valueOf } = require('../lib/server/mirror/retention');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The emitter's flush (emit.js FLUSH_MS 100), with room.
const SETTLE_MS = 250;

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-unload-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Timers that never fire on their own: `fire(ms)` runs the pending ones of that delay.
function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout(fn, ms) { const h = { fn, ms }; pending.add(h); return h; },
    clearTimeout(h) { pending.delete(h); },
    fire(ms) { for (const h of [...pending]) if (h.ms === ms) { pending.delete(h); h.fn(); } },
  };
}

// A facade whose `transcripts` source is a fake: `api` its api (pinned,
// ensureConversation, indexing, turns, …), `onUnloaded(ev, engine)` run inside
// its onConversation hook for an `unloaded` change.
function boot(t, { api = {}, parsedMax, timers, onUnloaded = null, extra = [] } = {}) {
  const root = project(t);
  const mirrorBus = createBus({ maxEvents: 5000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  const heard = [];
  const logs = [];
  const h = { root, frames, heard, logs, engine: null };
  const fake = (engine) => {
    h.engine = engine;
    return {
      start: async () => {},
      stop: async () => {},
      onConversation(ev) {
        heard.push({ change: ev.change, id: ev.conversation && ev.conversation.id, turns: engine.model.turnsOf(ev.conversation.id).length });
        if (ev.change === 'unloaded' && onUnloaded) onUnloaded(ev, engine);
      },
      api,
    };
  };
  const opts = {
    root, mirrorBus, mainBus: createBus(), redactor: createRedactor(), log: (m) => logs.push(String(m)),
    sources: [{ name: 'transcripts', attach: fake }, ...extra],
  };
  if (parsedMax !== undefined) opts.parsedMax = parsedMax;
  if (timers) opts.timers = timers;
  const mirror = createMirror(opts);
  h.mirror = mirror;
  t.after(() => mirror.stop());
  const events = [];
  mirror.subscribe((e) => events.push(e));
  h.events = events;
  let ts = Date.now();
  // Closed turns of `cid` (session `s-<cid>`), one batch: opener, reply, turn_duration each.
  h.turns = (cid, ids) => {
    const changes = [];
    for (const pid of ids) {
      ts += 10;
      changes.push({ type: 'opener', prompt_id: pid, kind: 'prompt', text: `prompt ${pid}`, ts, uuid: `u-${pid}` });
      changes.push({ type: 'item', uuid: `a-${pid}`, item: { id: `r-${pid}`, kind: 'reply', text: `reply to ${pid}` } });
      changes.push({ type: 'turn-duration', uuid: `d-${pid}`, duration_ms: 5 });
    }
    return h.engine.applyChanges(`s-${cid}`, changes, { conversation_id: cid });
  };
  // Every pending turn orphaned (the graph link's re-aim): nothing pins by R3.
  h.orphan = () => h.engine.model.orphanPending();
  h.held = (cid) => h.engine.model.turnsOf(cid).length;
  h.unloadedHeard = () => heard.filter((x) => x.change === 'unloaded').map((x) => x.id);
  return h;
}

// ── the number ───────────────────────────────────────────────────────────────

test('the budget\'s number: floor(64 MiB / the measured 416,958 B per parsed conversation) = 160, never below 20, read from the retention table', () => {
  assert.equal(PARSED_RAM_BYTES, 64 * 1024 * 1024);
  assert.equal(PARSED_CONVERSATIONS_MAX, Math.max(20, Math.floor(PARSED_RAM_BYTES / 416958)));
  assert.equal(PARSED_CONVERSATIONS_MAX, 160);
  assert.equal(PARSED_CONVERSATIONS_MAX, valueOf('parsed-conversations-max'));
});

// ── the model and the turn machine ───────────────────────────────────────────

function machine() {
  const model = createModel({ redactor: createRedactor() });
  const tm = createTurnMachine({ model });
  let ts = Date.now();
  const opener = (pid) => { ts += 10; return { type: 'opener', prompt_id: pid, kind: 'prompt', text: `prompt ${pid}`, ts, uuid: `u-${pid}` }; };
  return { model, tm, opener, tick: () => (ts += 10) };
}

test('an unknown conversation answers false, in the model and in the turn machine', () => {
  const { model, tm } = machine();
  assert.equal(model.unloadConversation('nope'), false);
  assert.equal(tm.unloadConversation('nope'), false);
  assert.equal(tm.unloadConversation(''), false);
  assert.equal(model.unloadedConversationOf('nope'), null);
});

test('the turn machine refuses while the conversation holds an open turn, and while it holds a pending one', () => {
  const { model, tm, opener } = machine();
  tm.applyChanges('c1', 's1', [opener('p-1')]);
  assert.equal(model.turn('p-1').status, 'open');
  assert.equal(tm.unloadConversation('c1'), false, 'an open turn');
  assert.equal(model.turnsOf('c1').length, 1, 'nothing left');
  tm.applyChanges('c1', 's1', [{ type: 'turn-duration', duration_ms: 5 }]);
  assert.equal(model.turn('p-1').status, 'done');
  assert.equal(tm.linkState('p-1'), 'pending');
  assert.equal(tm.unloadConversation('c1'), false, 'a pending (closed, unattached) turn');
  assert.equal(model.turnsOf('c1').length, 1);
  tm.attach('p-1', { id: 'node-1', label: 'n1.1' });
  assert.equal(tm.linkState('p-1'), 'attached');
  assert.equal(tm.unloadConversation('c1'), true, 'attached: unloaded');
  assert.equal(model.turnsOf('c1').length, 0);
  assert.ok(model.conversation('c1'), 'the conversation stays');
});

test('a re-open through restoreTurns gives back the same turn ids and seqs; a `replaces` alias resolves again; the locator answers until then', () => {
  const { model, tm, opener, tick } = machine();
  // A hook's provisional turn, bound by order to the transcript's opener: one alias.
  tm.openTurn('c1', { id: 'h_1', session_id: 's1', provisional: true, started_at: tick() });
  tm.applyChanges('c1', 's1', [opener('p-1'), { type: 'turn-duration', duration_ms: 5 }, opener('p-2'), { type: 'turn-duration', duration_ms: 5 }]);
  assert.equal(tm.resolve('h_1'), 'p-1', 'the hook id is an alias of the transcript turn');
  assert.equal(model.turn('p-1').replaces, 'h_1');
  tm.orphanPending();
  const before = model.turnsOf('c1').map((t) => ({ id: t.id, seq: t.seq }));
  assert.deepEqual(before.map((x) => x.id), ['p-1', 'p-2']);
  const entries = tm.exportTurns('s1');
  assert.equal(entries.length, 2);
  assert.equal(model.serializeConversation('c1').turn_count, 2);

  assert.equal(tm.unloadConversation('c1'), true);
  assert.equal(model.turnsOf('c1').length, 0);
  assert.equal(model.turn('p-1'), null);
  assert.equal(model.item('p_p-1'), null, 'its items are gone with it');
  assert.equal(tm.resolve('h_1'), 'h_1', 'the alias went with the turns');
  for (const id of ['p-1', 'p-2', 'h_1']) assert.equal(model.unloadedConversationOf(id), 'c1', `${id} is located`);
  assert.equal(model.unloadedConversationOf('p-9'), null);
  const conv = model.serializeConversation('c1');
  assert.ok(conv, 'the conversation row stays');
  assert.equal(conv.turn_count, 2, 'and counts the turns it held');

  const r = tm.restoreTurns('c1', entries);
  assert.deepEqual(r, { ok: true, restored: 2 });
  assert.deepEqual(model.turnsOf('c1').map((t) => ({ id: t.id, seq: t.seq })), before, 'the same ids and seqs');
  assert.equal(tm.resolve('h_1'), 'p-1', 'the replaces alias resolves again');
  for (const id of ['p-1', 'p-2', 'h_1']) assert.equal(model.unloadedConversationOf(id), null, `${id} is back`);
  assert.equal(model.serializeConversation('c1').turn_count, 2);
  // The kept per-conversation record: the next turn continues the seqs.
  tm.applyChanges('c1', 's1', [opener('p-3')]);
  assert.equal(model.turn('p-3').seq, 3);
});

// ── the facade: silence, ordering, the budget ────────────────────────────────

test('an unload is silent: the turns and items leave the model, no frame or event goes out for it, and the conversation stays in snapshot()', async (t) => {
  const h = boot(t, { api: { pinned: () => false }, parsedMax: 1 });
  h.turns('c1', ['a-1', 'a-2']);
  h.orphan();
  await waitUntil(() => h.frames.some((f) => f.conversation_id === 'c1' && f.type === 'mirror:stream'), { what: 'c1 sent' });
  await sleep(SETTLE_MS);
  const exported = h.engine.model.exportTurns('s-c1');
  const f0 = h.frames.length;
  const e0 = h.events.length;
  h.turns('c2', ['b-1']);
  assert.deepEqual(h.unloadedHeard(), ['c1'], 'the least recently used one went');
  assert.equal(h.held('c1'), 0);
  assert.equal(h.engine.model.turn('a-1'), null);
  assert.equal(h.engine.model.item('r-a-1'), null);
  assert.equal(h.engine.model.unloadedConversationOf('a-2'), 'c1');
  await sleep(SETTLE_MS);
  const after = h.frames.slice(f0);
  assert.ok(after.some((f) => f.conversation_id === 'c2'), 'c2\'s own frames went out');
  assert.deepEqual(after.filter((f) => f.conversation_id === 'c1'), [], 'no frame about c1');
  assert.deepEqual(after.filter((f) => f.type === 'mirror:reset'), [], 'no reset');
  assert.deepEqual(after.filter((f) => f.removed || (f.removed_items && f.removed_items.length)), [], 'nothing removed');
  assert.deepEqual(h.events.slice(e0).filter((e) => e.conversation_id === 'c1'), [], 'no ring event about c1');
  const snap = h.mirror.snapshot();
  const c1 = snap.conversations.find((c) => c.id === 'c1');
  assert.ok(c1, 'c1 stays in snapshot()');
  assert.equal(c1.turn_count, 2, 'with the turns it held');
  assert.deepEqual(snap.diagnostics.parsed, { max: 1, held: 1, unloaded: 1 });
  assert.deepEqual(h.logs.filter((l) => /unload|evict/i.test(l)), [], 'no log line per unload');

  // The re-open: the same ids and seqs, the locator cleared.
  const seqs = exported.map((e) => [e.header.id, e.header.seq]);
  h.orphan();
  const r = h.engine.model.restoreTurns('c1', exported);
  assert.equal(r.ok, true);
  assert.deepEqual(h.engine.model.turnsOf('c1').map((x) => [x.id, x.seq]), seqs);
  assert.equal(h.engine.model.unloadedConversationOf('a-2'), null);
  // restoreTurns was a use of c1: c2 (orphaned now) went instead.
  assert.deepEqual(h.unloadedHeard(), ['c1', 'c2']);
  assert.equal(h.held('c2'), 0);
});

test('the budget evicts the least recently used conversation that is not pinned: never the touched one, an eager one, or one with a pending turn; a transcripts read is a use', async (t) => {
  const eager = new Set();
  const h = boot(t, {
    parsedMax: 2,
    api: {
      pinned: (cid) => eager.has(cid),
      turns: async (cid) => ({ conversation_id: cid, turns: [], next_before: null, total: 0 }),
    },
  });
  h.turns('c1', ['a-1']); h.orphan();
  h.turns('c2', ['b-1']); h.orphan();
  assert.deepEqual(h.unloadedHeard(), [], 'two conversations fit');
  h.turns('c3', ['c-1']);
  assert.deepEqual(h.unloadedHeard(), ['c1'], 'a third unloads the least recently used');
  assert.ok(h.held('c2') && h.held('c3'));
  h.orphan();

  // A read through the dispatch is a use: c2 is now more recent than c3.
  await h.mirror.turns('c2');
  h.turns('c4', ['d-1']);
  assert.deepEqual(h.unloadedHeard(), ['c1', 'c3'], 'c3, not c2, after c2 was read');
  h.orphan();

  // An eager one (the provider pins it) is never unloaded.
  eager.add('c2');
  h.turns('c5', ['e-1']);
  assert.deepEqual(h.unloadedHeard(), ['c1', 'c3', 'c4'], 'c2 is eager: c4 goes');
  assert.ok(h.held('c2'));
  h.orphan();

  // One holding a pending turn is never unloaded, nor the touched one.
  eager.clear();
  h.turns('c2', ['b-2']); // c2 holds a pending turn now
  h.turns('c6', ['f-1']); // c5 is the only candidate
  assert.deepEqual(h.unloadedHeard(), ['c1', 'c3', 'c4', 'c5']);
  h.turns('c7', ['g-1']); // c2 and c6 pending, c7 touched: nothing can go
  assert.deepEqual(h.unloadedHeard(), ['c1', 'c3', 'c4', 'c5'], 'every candidate pinned');
  for (const cid of ['c2', 'c6', 'c7']) assert.ok(h.held(cid), `${cid} holds its turns`);
  assert.equal(h.mirror.snapshot().diagnostics.parsed.held, 3, 'over the budget while everything is pinned');
});

test('sources hear `unloaded` before the turns leave: the hook reads every turn, and a debounced index write flushed there is on disk with every turn (R1)', async (t) => {
  const timers = fakeTimers();
  let store = null;
  let read = null;
  const h = boot(t, {
    timers,
    parsedMax: 1,
    api: { pinned: () => false },
    onUnloaded: (ev, engine) => {
      read = engine.model.exportTurns(`s-${ev.conversation.id}`).map((e) => e.header.id);
      store.flush(`s-${ev.conversation.id}`);
    },
  });
  const engine = h.engine;
  store = createIndexStore({ paths: engine.paths, timers: engine.timers, now: engine.now, files: engine.files, redactor: engine.redactor });
  h.turns('c1', ['a-1', 'a-2', 'a-3']);
  h.orphan();
  const snapshot = () => ({
    session_id: 's-c1', conversation_id: 'c1', slug: null, file: null, resume: null,
    turns: engine.model.exportTurns('s-c1').map((e) => ({ id: e.header.id, header: e.header, internal: e.internal })),
    state: { meta: {}, skills: { names: [], descriptions: {} }, sources: {} },
  });
  store.schedule('s-c1', snapshot);
  const file = projectPaths(h.root).mirrorIndex('s-c1');
  assert.ok([...timers.pending].some((x) => x.ms === DEBOUNCE_MS), 'the write waits on its 2 s debounce');
  assert.equal(fs.existsSync(file), false, 'nothing on disk yet');

  h.turns('c2', ['b-1']);
  assert.deepEqual(h.unloadedHeard(), ['c1']);
  assert.deepEqual(read, ['a-1', 'a-2', 'a-3'], 'the hook read every turn, still in the model');
  assert.equal(h.heard.find((x) => x.change === 'unloaded').turns, 3, 'heard while c1 held its turns');
  assert.equal(h.held('c1'), 0, 'and they left after');
  assert.ok(fs.existsSync(file), 'the pending write is on disk when the unload returns');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.turns.map((x) => x.id), ['a-1', 'a-2', 'a-3'], 'with every turn');
  assert.ok(![...timers.pending].some((x) => x.ms === DEBOUNCE_MS), 'the debounce was taken by the flush');
  await store.stop();
});

test('with no api.pinned on the transcripts source nothing is unloaded at any count; the real transcripts source has none at this head', async (t) => {
  const h = boot(t, { parsedMax: 1, api: {} });
  for (const cid of ['c1', 'c2', 'c3', 'c4']) { h.turns(cid, [`${cid}-t`]); h.orphan(); }
  assert.deepEqual(h.unloadedHeard(), []);
  for (const cid of ['c1', 'c2', 'c3', 'c4']) assert.equal(h.held(cid), 1, `${cid} holds its turn`);
  assert.deepEqual(h.mirror.snapshot().diagnostics.parsed, { max: 1, held: 4, unloaded: 0 });

  // The real transcripts.js, registered (never started), with a recorder writing.
  const root = project(t);
  const mirror = createMirror({ root, mainBus: createBus(), redactor: createRedactor(), log: () => {}, sources: [], parsedMax: 1 });
  t.after(() => mirror.stop());
  const api = mirror.register('transcripts', createTranscriptsSource({ createStore: createIndexStore }).attach);
  assert.equal(Object.hasOwn(api, 'pinned'), false, 'transcripts.js has no api.pinned yet (U453 adds it)');
  const heard = [];
  let engine = null;
  mirror.register('recorder', (e) => {
    engine = e;
    return { start: async () => {}, stop: async () => {}, onConversation: (ev) => heard.push(ev.change) };
  });
  let ts = Date.now();
  for (const cid of ['r1', 'r2', 'r3']) {
    ts += 10;
    engine.applyChanges(`s-${cid}`, [{ type: 'opener', prompt_id: `${cid}-p`, kind: 'prompt', text: 'x', ts, uuid: `u-${cid}` },
      { type: 'turn-duration', duration_ms: 1, uuid: `d-${cid}` }], { conversation_id: cid });
    engine.model.orphanPending();
  }
  assert.deepEqual(heard.filter((c) => c === 'unloaded'), [], 'the real source is never sent `unloaded`');
  for (const cid of ['r1', 'r2', 'r3']) assert.equal(engine.model.turnsOf(cid).length, 1);
});

test('engine.ensureConversation and engine.indexing route to the transcripts source\'s api, and answer {ok: true} / false without one', async (t) => {
  const calls = [];
  const h = boot(t, {
    api: {
      ensureConversation: async (cid) => { calls.push(cid); if (cid === 'boom') throw new Error('x'); return cid === 'gone' ? { ok: false } : { ok: true }; },
      indexing: (cid) => { if (cid === 'boom') throw new Error('x'); return cid === 'c9'; },
    },
  });
  assert.deepEqual(await h.engine.ensureConversation('c1'), { ok: true });
  assert.deepEqual(await h.engine.ensureConversation('gone'), { ok: false, unavailable: true });
  assert.deepEqual(await h.engine.ensureConversation('boom'), { ok: false, unavailable: true });
  assert.deepEqual(calls, ['c1', 'gone', 'boom']);
  assert.equal(h.engine.indexing('c9'), true);
  assert.equal(h.engine.indexing('c1'), false);
  assert.equal(h.engine.indexing('boom'), false);

  const bare = boot(t, { api: {} });
  assert.deepEqual(await bare.engine.ensureConversation('c1'), { ok: true });
  assert.equal(bare.engine.indexing('c1'), false);
  // A source is never handed the unload itself, only the locator.
  assert.equal(typeof bare.engine.model.unloadConversation, 'undefined');
  assert.equal(typeof bare.engine.model.unloadedConversationOf, 'function');
});

test('createMirror refuses a parsedMax that is not a count', () => {
  for (const bad of [0, -1, 1.5, '3', null]) {
    assert.throws(() => createMirror({ root: SANDBOX, redactor: createRedactor(), sources: [], parsedMax: bad }), /parsedMax/);
  }
});

// A chat pin on a present conversation after a restart (PLAN.md 3E.3; RULED
// U453@eager-no-graph R4 a, U417@pending-diff-state Q7 a; DECISIONS.md
// K.2-176; U453a, the corrective to U453's lazy open and U456's gone rule).
//
// The daemon exactly as createServer wires it (withServer), over a scratch git
// repository (test-support/treesnap-fixture) with a private Claude tier
// (test-support/claude-home) fed only synthetic transcripts
// (test-support/claude-records) and v1 hook envelopes posted to the hook
// intake and the turn routes. Two server lives on one root each. Pinned:
//   * an EAGER conversation (no graph node: every conversation is eager, R4)
//     with a chat pin on its reply: read GET /api/elements at once after the
//     restart, and on every read until it places, the pin answers `indexing`
//     (with EXPLAIN's indexing line) or `exact` — never `unavailable`, the
//     state U456 keeps for a conversation that is gone;
//   * a LISTED, unparsed conversation (its activity before the graph's newest
//     node, no process): its pin answers `indexing`, and ONE chat read starts
//     its lazy open with no other reader (no turns read, no node read): the
//     mirror's lazy count says it parsed, and the next read answers `exact`;
//   * eight eager conversations, each with a pin: read at once after the
//     restart, the ones still queued on the transcripts source's job chain
//     answer `indexing`, never `unavailable` (TODO until the transcripts
//     source answers engine.opening: the grant U453a's hand-off asks for);
//   * the resolver alone (createChatAnchorsSource over a fake engine): a turn
//     missing while engine.opening → indexing, else unavailable 'gone'; a
//     kind's 'gone' while opening → indexing; {open: true} starts
//     engine.ensureConversation once per conversation answered indexing,
//     never awaited (a parse that never settles still answers), and a batch
//     without it starts none; an item whose turn came back as a header alone
//     is refilled through that turn's served read.
// A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, waitUntil } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const { createChatAnchorsSource } = require('../lib/server/mirror/chat-anchors');

const S1 = '11111111-1111-4111-8111-11111114530a';
const S2 = '22222222-2222-4222-8222-22222224530a';
const WAIT = { timeout: 15000, interval: 20 };
const CALL_TIMEOUT_MS = 15000;

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

function project(t) {
  const repo = treesnapRepo(t, { files: { 'README.md': 'boot state\n' } });
  const ch = claudeHome(t, { root: repo.root, isolate: true });
  return { repo, root: repo.root, ch };
}

// One server life on the project's root, and Claude Code's side of it.
async function life(t, p) {
  const d = await withServer(t, { root: p.root, writePortfile: true });
  const call = { port: d.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({
    hook_event_name: event, session_id: sid, transcript_path: p.ch.transcript(sid), cwd: p.ch.cwd, permission_mode: 'default', ...extra,
  }, env, { now: stamp() });
  const fire = async (event, extra, sid) => {
    const r = await client.post('/api/hooks/event', envelope(event, extra, sid), call);
    assert.equal(r.ok, true, `hook ${event}`);
  };
  const turnBegin = (promptId, text, sid) => {
    const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
    return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
  };
  const turnEnd = (reply, sid) => {
    const e = envelope('Stop', { last_assistant_message: reply }, sid);
    return client.post('/api/turn-end', { author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message }, call);
  };
  const snapshots = async () => {
    const s = await client.get('/api/mirror', call);
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };
  const lazy = async () => {
    const s = await client.get('/api/mirror', call);
    return (s.diagnostics && s.diagnostics.lazy) || null;
  };
  const turnsOf = (cid) => client.get(`/api/mirror/conversations/${cid}/turns?limit=50&items=full`, call);
  const chatPins = async () => (await ok(d.anonApi.get('/api/elements?type=chat-comment'), 'GET /api/elements')).elements;
  const get = (pth) => client.request(d.port, 'GET', pth, null, { timeout: CALL_TIMEOUT_MS });
  return { ...d, call, fire, turnBegin, turnEnd, snapshots, lazy, turnsOf, chatPins, get };
}

// A closed turn of `sid` whose reply the transcript holds; `work` runs inside
// it. Answers the turn-end's body and the reply item.
async function closedTurn(L, p, { sid, promptId, prompt, reply, seed, work = async () => {} }) {
  p.ch.writeTranscript(sid, []);
  await L.fire('SessionStart', { source: 'startup', model: 'claude-test' }, sid);
  const r = createRecords({ seed, sessionId: sid, cwd: p.ch.cwd, start: Date.now() - 60000, step: 50 });
  const seen = await L.snapshots();
  assert.equal((await L.turnBegin(promptId, prompt, sid)).ok, true, `${promptId} begins`);
  await waitUntil(async () => (await L.snapshots()) > seen, { ...WAIT, what: `${promptId}'s before-snapshot` });
  r.prompt(prompt, { promptId });
  await work();
  r.assistant([reply]);
  r.turnDuration({ durationMs: 200, messageCount: 4 });
  p.ch.writeTranscript(sid, r.records);
  const end = await L.turnEnd(reply, sid);
  await waitUntil(async () => {
    const pg = await L.turnsOf(sid);
    const x = (pg.turns || []).find((y) => y.id === promptId);
    return x && x.status !== 'open' && (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript') ? x : null;
  }, { ...WAIT, what: `${promptId} closed and the transcript's reply in` });
  const item = (await L.srv.mirror.turn(promptId)).items.find((it) => it.kind === 'reply' && it.source === 'transcript');
  assert.ok(item, `${promptId}'s reply`);
  return { end, reply: item };
}

async function pinOn(L, reply, text) {
  const e = (await ok(L.anonApi.post('/api/elements', {
    type: 'chat-comment', anchor: { kind: 'item', item_id: reply.id }, payload: { text, shared: true },
  }), `pin ${text}`)).element;
  assert.equal(e.state, 'exact', `${e.id} placed at create`);
  return e;
}

test('after a restart, a chat pin on an eagerly opened conversation answers indexing or exact from the first read, never unavailable', { timeout: 120000 }, async (t) => {
  const p = project(t);
  let L = null;
  t.after(async () => { if (L) await L.stop(); });

  L = await life(t, p);
  const one = await closedTurn(L, p, { sid: S1, promptId: 'bp-1', prompt: 'say something', reply: 'Here is a reply worth pinning.', seed: 4531 });
  const pin = await pinOn(L, one.reply, 'on the reply');
  assert.equal((await L.get('/api/graph')).body.nodes.length, 0, 'no node: every conversation is eager (R4)');
  await L.stop();

  L = await life(t, p);
  // At once, and on every read until it places.
  const seen = [];
  const placed = await waitUntil(async () => {
    const e = (await L.chatPins()).find((x) => x.id === pin.id);
    assert.ok(e, 'the pin is listed');
    seen.push(e.state);
    assert.notEqual(e.state, 'unavailable', `read ${seen.length}: ${JSON.stringify(e)} (states so far ${seen.join(', ')})`);
    if (e.state === 'indexing') assert.equal(e.explain, EXPLAIN.indexing);
    return e.state === 'exact' ? e : null;
  }, { ...WAIT, interval: 1, what: 'the pin places' });
  assert.equal(placed.visible, VISIBLE.exact);
  t.diagnostic(`states read: ${[...new Set(seen)].join(' → ')} over ${seen.length} reads`);
});

test('a listed, unparsed conversation\'s pin answers indexing, and one chat read starts its open: it resolves with no other reader', { timeout: 120000 }, async (t) => {
  const p = project(t);
  let L = null;
  t.after(async () => { if (L) await L.stop(); });

  L = await life(t, p);
  const one = await closedTurn(L, p, { sid: S1, promptId: 'lp-1', prompt: 'an older conversation', reply: 'An older reply, pinned before the node.', seed: 4532 });
  const pin = await pinOn(L, one.reply, 'on the older reply');
  await L.fire('SessionEnd', { reason: 'exit' }, S1);
  // A newer conversation commits the graph's first node, after S1's activity.
  const two = await closedTurn(L, p, {
    sid: S2, promptId: 'lq-1', prompt: 'render something', reply: 'Rendered.', seed: 4533,
    work: async () => { await ok(L.api.post('/api/render', { id: 'boot-pane', html: '<p>hello</p>' }), 'render'); },
  });
  assert.ok(two.end.node_id, `lq-1 committed a node: ${JSON.stringify(two.end)}`);
  await L.stop();

  L = await life(t, p);
  await L.srv.mirror.ready;
  const before = await waitUntil(async () => {
    const z = await L.lazy();
    return z && z.listed >= 1 ? z : null;
  }, { ...WAIT, what: 'S1 listed, not parsed' });
  // The first chat read: S1 is not parsed, so its pin is indexing.
  const first = (await L.chatPins()).find((x) => x.id === pin.id);
  assert.equal(first.state, 'indexing', JSON.stringify(first));
  assert.equal(first.explain, EXPLAIN.indexing);
  // That read alone starts the open: no turns read, no node read, nothing else.
  await waitUntil(async () => {
    const z = await L.lazy();
    return z && z.listed === before.listed - 1 && z.indexing === 0 ? z : null;
  }, { ...WAIT, what: 'the chat read parsed S1' });
  const after = (await L.chatPins()).find((x) => x.id === pin.id);
  assert.equal(after.state, 'exact', JSON.stringify(after));
});

// The pins of `n` eager conversations, read at once after a restart: the
// sessions still queued behind the others answer `indexing`, never
// `unavailable`. Needs the transcripts source's api.opening (engine.opening is
// false without it): the grant U453a's hand-off asks for, with its patch.
test('after a restart, the pins of conversations still queued for their eager open answer indexing, never unavailable', {
  timeout: 180000,
  todo: 'needs lib/server/mirror/transcripts.js api.opening (U453a hand-off: the grant and its patch)',
}, async (t) => {
  const p = project(t);
  let L = null;
  t.after(async () => { if (L) await L.stop(); });

  L = await life(t, p);
  const pins = [];
  for (let n = 0; n < 8; n++) {
    const sid = `33333333-3333-4333-8333-3333333453${String(n).padStart(2, '0')}`;
    const one = await closedTurn(L, p, { sid, promptId: `mp-${n}`, prompt: `say ${n}`, reply: `Reply number ${n} worth pinning.`, seed: 4540 + n });
    pins.push((await pinOn(L, one.reply, `pin ${n}`)).id);
  }
  await L.stop();

  L = await life(t, p);
  const rows = [];
  await waitUntil(async () => {
    const got = (await L.chatPins()).filter((e) => pins.includes(e.id));
    assert.equal(got.length, pins.length);
    rows.push(got.map((e) => e.state[0]).join(''));
    for (const e of got) assert.notEqual(e.state, 'unavailable', `read ${rows.length}: ${e.id} (reads ${rows.join(' ')})`);
    return got.every((e) => e.state === 'exact');
  }, { ...WAIT, interval: 1, what: 'every pin places' });
  t.diagnostic(`reads (i indexing, e exact): ${rows.join(' ')}`);
});

// ── the resolver alone, over a fake engine ───────────────────────────────────

const CID = 'c-1';
const CID2 = 'c-2';

// A fake engine: one turn t-1 (conversation c-1) with a reply item, the model's
// item held or not (`itemHeld`), and the facade's seams as the test sets them.
function fakeEngine(over = {}) {
  const turn = { id: 't-1', conversation_id: CID, session_id: 's-1', provisional: false };
  const reply = { id: 'r-1', kind: 'reply', turn_id: 't-1', source: 'transcript' };
  const st = { turns: new Map([['t-1', turn]]), itemHeld: true, ensured: [], turnReads: [] };
  const engine = {
    log: () => {},
    model: {
      resolveTurn: (id) => (st.turns.has(id) ? id : null),
      turn: (id) => st.turns.get(id) || null,
      item: (id) => (id === 'r-1' && st.itemHeld ? reply : null),
      turnsOf: () => [...st.turns.values()],
    },
    read: {
      itemField: async () => null,
      turn: async (id) => { st.turnReads.push(id); st.itemHeld = true; return { turn: { id }, items: [] }; },
    },
    indexing: () => false,
    opening: () => false,
    ensureConversation: (cid) => { st.ensured.push(cid); return new Promise(() => {}); },
    ...over,
  };
  const src = createChatAnchorsSource().attach(engine);
  return { st, engine, api: src.api, src };
}
const turnPin = (id, cid = CID, turnId = 't-1') => ({ id, v: 1, anchor: { v: 1, kind: 'turn', conversation_id: cid, session_id: 's-1', turn_id: turnId } });
const itemPin = (id) => ({ id, v: 1, anchor: { v: 1, kind: 'item', conversation_id: CID, session_id: 's-1', turn_id: 't-1', item_id: 'r-1', field: 'text' } });

test('the resolver: a turn missing while its conversation opens answers indexing; once open, or for a conversation not opening, unavailable gone', async () => {
  let open = true;
  const { api } = fakeEngine({ opening: (cid) => cid === CID && open });
  const [a] = await api.resolve([turnPin('k1', CID, 't-9')]);
  assert.deepEqual([a.state, a.visible, a.explain], ['indexing', VISIBLE.indexing, EXPLAIN.indexing]);
  assert.equal(a.rule, undefined);
  open = false;
  const [b] = await api.resolve([turnPin('k1', CID, 't-9')]);
  assert.deepEqual([b.state, b.rule], ['unavailable', 'gone']);
  // Another conversation, not opening: gone at once.
  open = true;
  const [c] = await api.resolve([turnPin('k2', CID2, 't-9')]);
  assert.deepEqual([c.state, c.rule], ['unavailable', 'gone']);
  // A turn the model holds places whatever opening says.
  const [d] = await api.resolve([turnPin('k3')]);
  assert.equal(d.state, 'exact');
});

test('the resolver: an opening that throws counts as no; a kind\'s gone while opening answers indexing with its turn', async () => {
  const thrower = fakeEngine({ opening: () => { throw new Error('boom'); } });
  const [a] = await thrower.api.resolve([turnPin('k1', CID, 't-9')]);
  assert.deepEqual([a.state, a.rule], ['unavailable', 'gone']);
  // The item missing and nothing refills it (no turn read): the item kind's gone.
  let open = true;
  const f = fakeEngine({ opening: () => open });
  f.st.itemHeld = false;
  f.engine.read.turn = async () => null;
  const [b] = await f.api.resolve([itemPin('k2')]);
  assert.deepEqual([b.state, b.turn_id], ['indexing', 't-1']);
  open = false;
  const [c] = await f.api.resolve([itemPin('k2')]);
  assert.deepEqual([c.state, c.rule], ['unavailable', 'gone']);
});

test('the resolver: {open: true} starts each indexing conversation\'s parse once, never awaited; a batch without it starts none', async () => {
  const f = fakeEngine({ indexing: (cid) => cid === CID || cid === CID2 });
  const batch = [turnPin('k1'), turnPin('k2'), turnPin('k3', CID2), turnPin('k4', CID2)];
  const plain = await f.api.resolve(batch);
  assert.deepEqual(plain.map((x) => x.state), ['indexing', 'indexing', 'indexing', 'indexing']);
  assert.deepEqual(f.st.ensured, [], 'a batch without open starts no parse');
  // ensureConversation never settles here: the read still answers.
  const opened = await f.api.resolve(batch, { open: true });
  assert.deepEqual(opened.map((x) => [x.id, x.state]), [['k1', 'indexing'], ['k2', 'indexing'], ['k3', 'indexing'], ['k4', 'indexing']]);
  assert.deepEqual(f.st.ensured, [CID, CID2], 'once per conversation per batch');
  // A parse that throws, synchronously or not, never breaks the read.
  const g = fakeEngine({ indexing: () => true, ensureConversation: () => { throw new Error('boom'); } });
  assert.equal((await g.api.resolve([turnPin('k1')], { open: true }))[0].state, 'indexing');
  const h = fakeEngine({ indexing: () => true, ensureConversation: () => Promise.reject(new Error('boom')) });
  assert.equal((await h.api.resolve([turnPin('k1')], { open: true }))[0].state, 'indexing');
  assert.equal(f.src.diagnostics().chat_anchors.opens, 2);
});

test('the resolver: an item whose turn came back as a header alone is refilled through that turn\'s served read', async () => {
  const f = fakeEngine();
  const [a] = await f.api.resolve([itemPin('k1')]);
  assert.equal(a.state, 'exact');
  assert.deepEqual(f.st.turnReads, [], 'an item in the model: no turn read');
  f.st.itemHeld = false;
  const [b] = await f.api.resolve([itemPin('k2')]);
  assert.deepEqual([b.state, b.at], ['exact', { item_id: 'r-1' }]);
  assert.deepEqual(f.st.turnReads, ['t-1'], 'one read of the anchor\'s turn');
});

// On-demand rebuild and the `indexing` state (annotation engine PLAN.md 3E.3,
// U454; ruled REQ@on-demand-rebuild a, REQ@visible-states a,
// REQ@list-never-waits a, U414@explain-lines Q6 = a): the transcripts source
// (lib/server/mirror/transcripts.js) over the real index store
// (lib/server/mirror/index-store.js) and the real facade.
//
// Pinned, through a REAL createMirror with the real SOURCES (the transcripts
// entry rebuilt with indexingWaitMs: 20, over the real createIndexStore wrapped
// to count its loads, record their answers and hold one when asked, and a
// tailer factory that records each tailer it makes):
//   * a listed conversation whose index file was deleted: the first turns(cid)
//     answers {indexing: true, turns: []} once the bound passes, exactly one
//     mirror:reset scoped to that conversation goes out when the parse lands,
//     and turns(cid) then answers its turns, rebuilt by one scan from 0;
//   * a truncated transcript (shorter than the index's resume offset): load
//     answers stale and the session is read again from 0;
//   * a gone transcript (unlinked, its slug directory there) with its index on
//     disk: load answers gone, the headers are answered, a full read answers
//     items_unavailable, no tailer is made and readWindow is never asked for
//     the file;
//   * its slug directory removed: stale, not gone — nothing is read, the index
//     is left as it is;
//   * the resolver through the facade: a chat anchor on a listed, unparsed
//     conversation answers `indexing` with its EXPLAIN line from a
//     resolveAnchors batch and kicks no parse; after turns(cid) it is placed;
//   * the routes: GET …/conversations/:cid/turns (local and at read) and
//     GET /api/mirror/turns/:turnId of an unloaded turn carry indexing: true
//     while the bound is exceeded.
//
// The Claude tier is a private fake (test-support/claude-home, isolate: true);
// transcripts are built by test-support/claude-records; nothing is copied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { createRecords } = require('../test-support/claude-records');
const { request } = require('../lib/client');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { EXPLAIN } = require('../lib/core/anchor-states');
const { atLeast, fromOptIn, MIRROR_HINT } = require('../lib/core/remote-policy');
const { isRemoteRequest } = require('../lib/core/cors');
const claudeFiles = require('../lib/core/claude-files');
const { resolvePaths } = require('../lib/server/paths');
const { createState } = require('../lib/server/state');
const { createGraph } = require('../lib/server/graph');
const { createHookTap } = require('../lib/server/hook-tap');
const turnsDomain = require('../lib/server/domain/turns');
const { mountMirrorContentRoutes } = require('../lib/server/routes/mirror-content');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTranscriptsSource, INDEXING_WAIT_MS } = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const { createTailer: realTailer } = require('../lib/server/mirror/tail');

const DAY = 24 * 60 * 60 * 1000;
const BOUND_MS = 20;

// A session id the registry accepts: hex, in the UUID shape.
const sid = (n, k = 0) => `${(0xb0000000 + k).toString(16)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── fixtures ─────────────────────────────────────────────────────────────────

// A temp project, its private Claude tier, and a real graph with `nodes`
// committed nodes (0: every conversation is eager, R4).
function world(t, { nodes = 0 } = {}) {
  withTempHome(t);
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-indexing-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  const paths = resolvePaths(root);
  const state = createState();
  const graph = createGraph({ paths, state, draftPath: projectPaths(root).draft });
  graph.load();
  const bus = createBus();
  const w = { root, ch, graph, state, bus };
  w.commit = () => {
    state.store.k = Date.now() + Math.random();
    return turnsDomain.commitNode(graph, bus, {
      draftPath: graph.draftPath, parentId: graph.active, author: 'claude', triggerKind: 'manual',
      message: 'm', clearLock: false, op: 'commit', includeLabelAndUnlock: false,
    }).node_id;
  };
  for (let i = 0; i < nodes; i++) w.commit();
  w.index = (s) => projectPaths(root).mirrorIndex(s);
  return w;
}

// A closed turn: prompt, reply, turn_duration.
function closedTurn(r, promptId) {
  r.prompt(`prompt ${promptId}`, { promptId });
  r.assistant([`reply to ${promptId}`]);
  r.turnDuration({ durationMs: 50 });
}

let nextSeed = 400;
// Records of `ids` closed turns for session `s`; `cut[k]` the record count
// after the k-th turn.
function transcript(w, s, ids, at) {
  const r = createRecords({ seed: nextSeed++, sessionId: s, cwd: w.ch.cwd, start: at, step: 10 });
  const cut = [];
  for (const id of ids) { closedTurn(r, id); cut.push(r.records.length); }
  w.ch.writeTranscript(s, r.records);
  return { r, cut };
}

// One stored, ended conversation in serializeRecord's shape (conversations.js),
// its sessions a /clear chain.
function stored(w, { id, sessions = [id], lastActivity }) {
  const created = lastActivity - 1000;
  return {
    id, created_at: created, last_activity_at: lastActivity, ended_at: lastActivity,
    title: null, name: null, forked_from: null, current_session_id: sessions[sessions.length - 1], entrypoint: 'cli',
    sessions: sessions.map((s, i) => ({
      session_id: s, slug: w.ch.slug, reason: i === 0 ? 'start' : 'clear', started_at: created + i,
      ended_at: i < sessions.length - 1 ? created + i + 1 : null,
    })),
    process: null,
  };
}

function writeRegistry(w, list) {
  const file = projectPaths(w.root).mirrorConversations;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { v: 1, conversations: list });
}

// The real index store: its loads counted with their answers; `hold(sid)`
// makes that session's next load wait until `release()`.
function countingStore() {
  const loads = [];
  const answers = [];
  const held = new Map();
  const create = (opts) => {
    const s = createIndexStore(opts);
    return {
      async load(id, o) {
        loads.push(id);
        const gate = held.get(id);
        if (gate) { held.delete(id); await gate; }
        const a = await s.load(id, o);
        answers.push({ id, reason: a.ok ? 'ok' : a.reason, index: !!a.index });
        return a;
      },
      schedule: (...a) => s.schedule(...a),
      flush: (...a) => s.flush(...a),
      drop: (...a) => s.drop(...a),
      readRange: (...a) => s.readRange(...a),
      stop: () => s.stop(),
    };
  };
  const hold = (id) => {
    let release;
    held.set(id, new Promise((r) => { release = r; }));
    return () => release();
  };
  return { create, loads, answers, hold };
}

// A real facade over the world: the real SOURCES, the transcripts source over
// the counting store with a bound of BOUND_MS, every tailer it makes recorded.
function boot(t, w, { store = countingStore(), parsedMax, indexingWaitMs = BOUND_MS, conversationsOptions } = {}) {
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 5000 });
  const frames = [];
  mirrorBus.setBroadcaster((f) => frames.push(f));
  const tailers = [];
  const createTailer = (opts) => {
    tailers.push({ file: opts.file, resume: opts.resume });
    return realTailer(opts);
  };
  const sources = SOURCES.map((s) => (s.name === 'transcripts'
    ? { name: 'transcripts', attach: createTranscriptsSource({ createStore: store.create, createTailer, pollMs: 40, indexingWaitMs }).attach }
    : s));
  const mirror = createMirror({
    root: w.root, graph: w.graph, hooks, mainBus: w.bus, mirrorBus, redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources,
    ...(parsedMax ? { parsedMax } : {}),
    ...(conversationsOptions ? { conversationsOptions } : {}),
  });
  let stopped = false;
  const h = { mirror, store, frames, tailers, w };
  h.stop = async () => { if (!stopped) { stopped = true; await mirror.stop(); } };
  t.after(() => h.stop());
  h.conv = (cid) => mirror.snapshot({ since: 0 }).conversations.find((c) => c.id === cid) || null;
  // A chat host's read, again until it is not `indexing` (the parse runs on
  // behind an indexing answer, so the bound never decides what this reads).
  h.read = (cid, q = {}) => waitUntil(async () => {
    const p = await mirror.turns(cid, { limit: 100, ...q });
    return p && p.indexing !== true ? p : null;
  }, { timeout: 15000, what: `${cid}'s turns` });
  h.ids = async (cid) => {
    const p = await h.read(cid);
    return Array.isArray(p.turns) ? p.turns.map((x) => x.id) : p;
  };
  h.resets = (cid) => frames.filter((f) => f.type === 'mirror:reset' && f.conversation_id === cid);
  h.tailersOf = (s) => tailers.filter((x) => path.basename(String(x.file)) === `${s}.jsonl`);
  return h;
}

// A first daemon with no graph node parses everything and, at its stop, writes
// each session's index; the world then gets a node, so a later daemon only
// LISTS these old conversations.
async function indexed(t, w, specs) {
  const first = boot(t, w, { indexingWaitMs: INDEXING_WAIT_MS });
  await first.mirror.start();
  for (const { id, ids } of specs) {
    await waitUntil(() => (first.conv(id) || {}).turn_count === ids.length, { timeout: 15000, what: `${id} parsed` });
  }
  const out = { first };
  out.stopFirst = async () => {
    await first.stop();
    for (const { id } of specs) assert.ok(fs.existsSync(w.index(id)), `${id}: the first daemon wrote its index`);
    w.commit();
  };
  return out;
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// Count lib/core/claude-files readWindow calls on one session's transcript from
// now on (the facade captures readWindow when a mirror is built, so this wraps
// it before one is). The wrap comes off at the test's end.
function countWindows(t, s) {
  const real = claudeFiles.readWindow;
  const calls = [];
  claudeFiles.readWindow = (file, opts) => {
    if (path.basename(String(file)) === `${s}.jsonl`) calls.push({ ...opts });
    return real(file, opts);
  };
  t.after(() => { claudeFiles.readWindow = real; });
  return calls;
}

// ── the indexing answer and the rebuild ──────────────────────────────────────

test('INDEXING_WAIT_MS is 2 s and exported; indexingWaitMs must be milliseconds', () => {
  assert.equal(INDEXING_WAIT_MS, 2000);
  assert.throws(() => createTranscriptsSource({ createStore: () => ({}), indexingWaitMs: -1 }), /indexingWaitMs/);
  assert.throws(() => createTranscriptsSource({ createStore: () => ({}), indexingWaitMs: '20' }), /indexingWaitMs/);
});

test('an index deleted: the first turns(cid) answers indexing past the bound, exactly one scoped mirror:reset when the whole parse lands, then the turns rebuilt by one scan from 0', async (t) => {
  const w = world(t);
  // Two sessions (a /clear chain): each one's catch-up nests inside the
  // parse's one index scope, so the first session's end sends no reset.
  const [a, a2, b] = [sid(1, 1), sid(2, 1), sid(3, 1)];
  const at = Date.now() - 3 * DAY;
  transcript(w, a, ['a-1', 'a-2'], at);
  transcript(w, a2, ['a-3'], at + 5000);
  transcript(w, b, ['b-1'], at);
  writeRegistry(w, [stored(w, { id: a, sessions: [a, a2], lastActivity: at + 6000 }), stored(w, { id: b, lastActivity: at })]);
  const run = await indexed(t, w, [{ id: a, ids: ['a-1', 'a-2', 'a-3'] }, { id: b, ids: ['b-1'] }]);
  await run.stopFirst();
  fs.rmSync(w.index(a));
  fs.rmSync(w.index(a2));

  const h = boot(t, w);
  await h.mirror.start();
  await settle();
  assert.deepEqual(h.store.loads, [], 'listed, not parsed');
  assert.equal(h.conv(a).turn_count, 0);

  const release = h.store.hold(a2);
  t.after(release);
  const first = await h.mirror.turns(a, { limit: 100 });
  assert.deepEqual(first, {
    conversation_id: a, turns: [], next_before: null, total: null, indexing: true, explain: EXPLAIN.indexing,
  }, 'indexing, with the state\'s one line');
  await waitUntil(() => h.store.loads.includes(a2), { timeout: 10000, what: 'the second session\'s load' });
  await settle();
  assert.equal(h.resets(a).length, 0, 'no reset while the parse runs, though its first session is read');
  assert.equal(h.mirror.snapshot({ since: 0 }).conversations.find((c) => c.id === a).turn_count, 2, 'the first session is in');

  release();
  await waitUntil(() => h.resets(a).length > 0, { timeout: 10000, what: 'the conversation\'s reset' });
  await settle();
  assert.equal(h.resets(a).length, 1, 'exactly one mirror:reset scoped to the conversation');
  assert.deepEqual(h.resets(a)[0], { type: 'mirror:reset', reason: 'catch-up', conversation_id: a });
  assert.equal(h.resets(b).length, 0, 'none for the conversation nobody read');

  const page = await h.mirror.turns(a, { limit: 100 });
  assert.deepEqual(page.turns.map((x) => x.id), ['a-1', 'a-2', 'a-3'], 'the turns, after the reset');
  assert.equal(page.indexing, undefined, 'a page that is not indexing carries no flag');
  assert.deepEqual(h.store.answers.map((x) => x.reason), ['absent', 'absent']);
  for (const s of [a, a2]) {
    assert.equal(h.tailersOf(s).length, 1, `${s}: one scan`);
    assert.equal(h.tailersOf(s)[0].resume, null, `${s}: from 0`);
  }
  assert.deepEqual(h.store.loads, [a, a2], 'and nothing loaded again');
});

test('a truncated transcript (shorter than the index\'s resume offset): load answers stale and the session is read again from 0', async (t) => {
  const w = world(t);
  const a = sid(1, 2);
  const at = Date.now() - 3 * DAY;
  const { r, cut } = transcript(w, a, ['t-1', 't-2', 't-3'], at);
  writeRegistry(w, [stored(w, { id: a, lastActivity: at })]);
  const run = await indexed(t, w, [{ id: a, ids: ['t-1', 't-2', 't-3'] }]);
  await run.stopFirst();
  const ix = JSON.parse(fs.readFileSync(w.index(a), 'utf8'));
  // The same file, cut to its first turn in place: size < resume.offset.
  const file = w.ch.transcript(a);
  const kept = r.records.slice(0, cut[0]).map((x) => `${JSON.stringify(x)}\n`).join('');
  fs.truncateSync(file, Buffer.byteLength(kept));
  assert.ok(fs.statSync(file).size < ix.resume.offset, 'below the resume offset');

  const h = boot(t, w);
  await h.mirror.start();
  await settle();
  assert.deepEqual(await h.ids(a), ['t-1'], 'what the file now holds');
  assert.deepEqual(h.store.answers, [{ id: a, reason: 'stale', index: false }]);
  assert.equal(h.tailersOf(a).length, 1);
  assert.equal(h.tailersOf(a)[0].resume, null, 're-scanned from 0');
});

// ── gone ─────────────────────────────────────────────────────────────────────

test('a gone transcript with its index on disk: load answers gone, its headers are answered, a full read answers items_unavailable, no tailer, and readWindow is never asked for the file', async (t) => {
  const w = world(t);
  const a = sid(1, 3);
  const at = Date.now() - 3 * DAY;
  transcript(w, a, ['g-1', 'g-2'], at);
  writeRegistry(w, [stored(w, { id: a, lastActivity: at })]);
  const run = await indexed(t, w, [{ id: a, ids: ['g-1', 'g-2'] }]);
  await run.stopFirst();
  const file = w.ch.transcript(a);
  const before = fs.readFileSync(w.index(a), 'utf8');
  fs.rmSync(file);
  assert.equal(claudeFiles.transcriptGone(file), true, 'Claude Code\'s cleanup, by the one rule');

  const windows = countWindows(t, a);
  // The registry's boot sweep would delete the index of a gone transcript at
  // once (U451, conversations.js deleteGone): its rule is held off here, so
  // the index the sweep deletes later is the one this read finds.
  const h = boot(t, w, { conversationsOptions: { transcriptGone: () => false } });
  await h.mirror.start();
  await settle();
  const page = await h.read(a, { items: 'full' });
  assert.deepEqual(page.turns.map((x) => x.id), ['g-1', 'g-2'], 'the headers, from the index');
  assert.ok(page.turns.every((x) => x.items_unavailable === true), 'read-only: items unavailable');
  const one = await h.mirror.turn('g-2');
  assert.equal(one.turn.id, 'g-2');
  assert.equal(one.items_unavailable, true);
  assert.deepEqual(h.store.answers, [{ id: a, reason: 'gone', index: true }]);
  assert.equal(h.tailersOf(a).length, 0, 'no tailer');
  assert.deepEqual(windows, [], 'readWindow never asked for the file: no scan');
  assert.equal(h.conv(a).turn_count, 2);
  await h.stop();
  assert.equal(fs.readFileSync(w.index(a), 'utf8'), before, 'the index is never written again (the sweep deletes it, U451)');
});

test('the slug directory removed: stale, not gone — nothing is read, the index is left as it is', async (t) => {
  const w = world(t);
  const a = sid(1, 4);
  const at = Date.now() - 3 * DAY;
  transcript(w, a, ['s-1'], at);
  writeRegistry(w, [stored(w, { id: a, lastActivity: at })]);
  const run = await indexed(t, w, [{ id: a, ids: ['s-1'] }]);
  await run.stopFirst();
  const file = w.ch.transcript(a);
  const before = fs.readFileSync(w.index(a), 'utf8');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(claudeFiles.transcriptGone(file), false, 'no slug directory: not a cleanup');

  const windows = countWindows(t, a);
  const h = boot(t, w);
  await h.mirror.start();
  await settle();
  const page = await h.read(a);
  assert.deepEqual(page.turns, [], 'nothing to show');
  assert.deepEqual(h.store.answers, [{ id: a, reason: 'stale', index: false }]);
  assert.equal(h.tailersOf(a).length, 0, 'nothing is scanned');
  assert.deepEqual(windows, []);
  await h.stop();
  assert.equal(fs.readFileSync(w.index(a), 'utf8'), before, 'nothing deleted, nothing rewritten');
});

// ── the resolver ─────────────────────────────────────────────────────────────

test('a chat anchor on a listed, unparsed conversation answers indexing with its EXPLAIN line from a resolveAnchors batch and kicks no parse; after turns(cid) it is placed', async (t) => {
  const w = world(t);
  const a = sid(1, 5);
  const at = Date.now() - 3 * DAY;
  transcript(w, a, ['r-1', 'r-2'], at);
  writeRegistry(w, [stored(w, { id: a, lastActivity: at })]);
  const run = await indexed(t, w, [{ id: a, ids: ['r-1', 'r-2'] }]);
  const rec = await run.first.mirror.recordAnchor({ kind: 'turn', turn_id: 'r-2' });
  assert.ok(rec && rec.anchor, 'recorded while parsed');
  await run.stopFirst();

  const h = boot(t, w);
  await h.mirror.start();
  await settle();
  const [listed] = await h.mirror.resolveAnchors([{ id: 'k1', v: 1, anchor: rec.anchor }]);
  assert.equal(listed.state, 'indexing');
  assert.equal(listed.visible, 'indexing');
  assert.equal(listed.explain, EXPLAIN.indexing, 'the one table\'s line');
  await settle(100);
  assert.deepEqual(h.store.loads, [], 'a list kicks no parse (store.load never called)');

  assert.deepEqual(await h.ids(a), ['r-1', 'r-2'], 'a chat host\'s read parses it');
  const [placed] = await h.mirror.resolveAnchors([{ id: 'k1', v: 1, anchor: rec.anchor }]);
  assert.equal(placed.visible, 'placed');
  assert.equal(placed.explain, EXPLAIN.placed);
});

// ── the routes ───────────────────────────────────────────────────────────────

// §5.4's gate on the real level order: a plain loopback request is `local`;
// one with the portal's label gets the opt-in (here `read`).
function readAudience() {
  return {
    levelOf: (req) => (isRemoteRequest(req) ? fromOptIn('read') : 'local'),
    requireMirror(need) {
      return (req, res, next) => (atLeast(this.levelOf(req), need) ? next()
        : res.status(403).json({ ok: false, hint: MIRROR_HINT }));
    },
  };
}

async function routes(t, mirror) {
  const app = express();
  mountMirrorContentRoutes(app, { mirror, audience: readAudience() });
  const srv = http.createServer(app);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => { srv.closeAllConnections(); srv.close(res); }));
  const { port } = srv.address();
  return (p, { remote = false } = {}) => request(port, 'GET', p, null, { headers: remote ? { 'X-WC-Remote': '1' } : {}, timeout: 20000 });
}

test('GET …/conversations/:cid/turns carries indexing: true, local and at read, while the bound is exceeded; then the turns', async (t) => {
  const w = world(t);
  const a = sid(1, 6);
  const at = Date.now() - 3 * DAY;
  transcript(w, a, ['h-1'], at);
  writeRegistry(w, [stored(w, { id: a, lastActivity: at })]);
  const run = await indexed(t, w, [{ id: a, ids: ['h-1'] }]);
  await run.stopFirst();
  const h = boot(t, w);
  await h.mirror.start();
  const get = await routes(t, h.mirror);
  const release = h.store.hold(a);
  t.after(release);
  for (const remote of [false, true]) {
    const r = await get(`/api/mirror/conversations/${a}/turns`, { remote });
    assert.equal(r.status, 200, `remote ${remote}`);
    assert.equal(r.body.indexing, true);
    assert.equal(r.body.explain, EXPLAIN.indexing);
    assert.deepEqual(r.body.turns, []);
    assert.equal(r.body.total, null);
    assert.equal(r.body.next_before, null);
    assert.equal(r.body.conversation_id, a);
    assert.ok(Number.isFinite(r.body.rev));
  }
  release();
  await waitUntil(() => h.resets(a).length > 0, { timeout: 10000, what: 'the reset' });
  const r = await get(`/api/mirror/conversations/${a}/turns`);
  assert.deepEqual(r.body.turns.map((x) => x.id), ['h-1']);
  assert.ok(!('indexing' in r.body) && !('explain' in r.body), 'no flag once parsed');
});

test('GET /api/mirror/turns/:turnId of a turn the budget unloaded carries indexing: true while its parse outlasts the bound; then the turn', async (t) => {
  // A graph node from the start: these old turns close orphaned, never pending
  // (R3), so the budget may unload them.
  const w = world(t, { nodes: 1 });
  const [a, b] = [sid(1, 7), sid(2, 7)];
  const at = Date.now() - 3 * DAY;
  transcript(w, a, ['u-1', 'u-2'], at);
  transcript(w, b, ['v-1'], at);
  writeRegistry(w, [stored(w, { id: a, lastActivity: at }), stored(w, { id: b, lastActivity: at })]);
  const h = boot(t, w, { parsedMax: 1 });
  await h.mirror.start();
  const get = await routes(t, h.mirror);
  assert.deepEqual(await h.ids(a), ['u-1', 'u-2']);
  assert.deepEqual(await h.ids(b), ['v-1']);
  assert.deepEqual(h.mirror.snapshot({}).diagnostics.lazy, { listed: 1, parsed: 1, indexing: 0 }, 'a unloaded at parsedMax 1');

  const resetsBefore = h.resets(a).length;
  const release = h.store.hold(a);
  t.after(release);
  for (const remote of [false, true]) {
    const r = await get('/api/mirror/turns/u-2', { remote });
    assert.equal(r.status, 200, `remote ${remote}`);
    assert.deepEqual({ indexing: r.body.indexing, explain: r.body.explain }, { indexing: true, explain: EXPLAIN.indexing });
    assert.ok(!('turn' in r.body) && !('items' in r.body));
  }
  release();
  await waitUntil(() => h.resets(a).length > resetsBefore, { timeout: 10000, what: 'a\'s reset' });
  const r = await waitUntil(async () => {
    const x = await get('/api/mirror/turns/u-2');
    return x.body && x.body.turn ? x : null;
  }, { timeout: 10000, what: 'the turn' });
  assert.equal(r.body.turn.id, 'u-2', 'the turn, once parsed again');
  assert.ok(!('indexing' in r.body));
});

test('the bound is the route\'s alone (K.2-164): mod resumeCheck on a turn the budget unloaded waits for the parse past the bound and refuses no \'unknown\', while GET /api/mirror/turns/:turnId stays bounded', async (t) => {
  const { installModControl } = require('../lib/server/control/mod');
  const w = world(t, { nodes: 1 });
  const [a, b] = [sid(1, 8), sid(2, 8)];
  const at = Date.now() - 3 * DAY;
  transcript(w, a, ['u-1', 'u-2'], at);
  transcript(w, b, ['v-1'], at);
  writeRegistry(w, [stored(w, { id: a, lastActivity: at }), stored(w, { id: b, lastActivity: at })]);
  const h = boot(t, w, { parsedMax: 1 });
  await h.mirror.start();
  const get = await routes(t, h.mirror);
  assert.deepEqual(await h.ids(a), ['u-1', 'u-2']);
  assert.deepEqual(await h.ids(b), ['v-1']);
  assert.deepEqual(h.mirror.snapshot({}).diagnostics.lazy, { listed: 1, parsed: 1, indexing: 0 }, 'a unloaded at parsedMax 1');

  // The control domain's resume row, as the daemon installs it (the experimental
  // flag on, a fork seam present, no mod attached).
  const actions = new Map();
  const control = { action: (name, spec) => { actions.set(name, spec); return () => {}; } };
  const off = installModControl(control, { mirror: h.mirror, forkTurn: async () => ({}), env: { WEB_CHAT_REWIND_IN_PLACE: '1' } });
  t.after(() => { if (off && typeof off.remove === 'function') off.remove(); });
  const resume = actions.get('resume');
  assert.ok(resume && typeof resume.check === 'function', 'the resume row');

  const release = h.store.hold(a);
  t.after(release);
  const checked = resume.check({ turn_id: 'u-2' });
  // The route's read of the same turn, meanwhile, answers indexing at the bound.
  const r = await get('/api/mirror/turns/u-2');
  assert.deepEqual({ indexing: r.body.indexing, explain: r.body.explain }, { indexing: true, explain: EXPLAIN.indexing }, 'the route stays bounded');
  await settle(BOUND_MS * 5);
  let settled = false;
  checked.then(() => { settled = true; });
  await settle(20);
  assert.equal(settled, false, 'resumeCheck still waits for the parse past the bound');
  release();
  const answer = await checked;
  assert.ok(answer && answer.refused !== 'unknown', `no 'unknown' refusal: ${JSON.stringify(answer)}`);
  assert.equal(answer.refused, 'no-mod', 'it got the turn and stopped at the next check (no mod attached)');
});

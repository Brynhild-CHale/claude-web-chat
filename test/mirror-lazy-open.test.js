// The lazy open (annotation engine PLAN.md 3E.2 part 2; ruled REQ@lazy-index b,
// EAGER@cutoff a, REQ@list-never-waits a, U453@eager-no-graph a; DECISIONS.md
// K.2-161): the transcripts source (lib/server/mirror/transcripts.js) opens
// only the eager set at boot — the conversations a live Claude Code writes,
// their fork sources, and those active after the graph's newest node — and
// parses every other conversation on first use.
//
// Pinned, through a REAL createMirror with the real SOURCES (the transcripts
// entry rebuilt over the real createIndexStore, wrapped to count its loads and
// hold one when asked), a real graph (lib/server/graph, nodes committed by
// domain/turns commitNode) and a conversations.json written in the registry's
// own record shape (conversations.js serializeRecord):
//   * a 50-conversation registry boots loading exactly the eager five's
//     sessions; the other 45 are listed with no turns; diagnostics.lazy counts
//     them; with no graph node every conversation is eager;
//   * a first turns(cid) of a listed conversation loads its sessions once and
//     answers its turns, a second loads nothing;
//   * a resumed old session: the rewind its index persisted is in the model
//     before the first new record's turn opens (load-then-tail, R2);
//   * a fork whose source is listed: the source is loaded first and the fork's
//     copied openers stay the source's (R4);
//   * the toggle: an ensureConversation waiting across a switch-off resolves
//     unavailable and the turns route answers 503; the switch-on opens only
//     the eager set;
//   * `unloaded` (U452's budget at parsedMax 1): the index on disk keeps every
//     turn; turns(cid) and turn(id) parse again and answer the same ids;
//   * a hook envelope for an unloaded conversation reopens it as its new turn
//     opens: its turn_count holds (K.2-161).
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
const { branch } = require('../test-support/rewind-fixtures');
const { request } = require('../lib/client');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { resolvePaths } = require('../lib/server/paths');
const { createState } = require('../lib/server/state');
const { createGraph } = require('../lib/server/graph');
const { createHookTap } = require('../lib/server/hook-tap');
const { createAudience } = require('../lib/server/audience');
const turnsDomain = require('../lib/server/domain/turns');
const { mountMirrorContentRoutes } = require('../lib/server/routes/mirror-content');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const { bootCutoff } = require('../lib/server/mirror/graph-link');

const DAY = 24 * 60 * 60 * 1000;
const LIVE_PID = 4242;

// A session id the registry accepts: hex, in the UUID shape.
const sid = (n, k = 0) => `${(0xa0000000 + k).toString(16)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── fixtures ─────────────────────────────────────────────────────────────────

// A temp project, its private Claude tier, and a real graph with `nodes`
// committed nodes (0: no node at all).
function world(t, { nodes = 1 } = {}) {
  withTempHome(t);
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-lazy-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  const paths = resolvePaths(root);
  const state = createState();
  const graph = createGraph({ paths, state, draftPath: projectPaths(root).draft });
  graph.load();
  const bus = createBus();
  const w = { root, ch, graph, state, bus, paths };
  w.commit = () => {
    state.store.k = Date.now() + Math.random();
    return turnsDomain.commitNode(graph, bus, {
      draftPath: graph.draftPath, parentId: graph.active, author: 'claude', triggerKind: 'manual',
      message: 'm', clearLock: false, op: 'commit', includeLabelAndUnlock: false,
    }).node_id;
  };
  for (let i = 0; i < nodes; i++) w.commit();
  w.cutoff = () => bootCutoff(graph);
  return w;
}

// A closed turn: prompt, reply, turn_duration.
function closedTurn(r, promptId) {
  r.prompt(`prompt ${promptId}`, { promptId });
  r.assistant([`reply to ${promptId}`]);
  r.turnDuration({ durationMs: 50 });
}

// Records of `ids` closed turns for session `s`, timestamped `at` on. Each
// transcript its own seed: records of one seed share their uuids, and an opener
// whose uuid another conversation holds reads as a fork's copy.
let nextSeed = 100;
function transcript(w, s, ids, at) {
  const r = createRecords({ seed: nextSeed++, sessionId: s, cwd: w.ch.cwd, start: at, step: 10 });
  for (const id of ids) closedTurn(r, id);
  w.ch.writeTranscript(s, r.records);
  return r;
}

// One stored conversation in serializeRecord's shape (conversations.js).
function stored(w, { id, sessions = [id], lastActivity, ended = true, live = false, forkedFrom = null }) {
  const created = lastActivity - 1000;
  return {
    id, created_at: created, last_activity_at: lastActivity,
    ended_at: ended && !live ? lastActivity : null,
    title: null, name: null, forked_from: forkedFrom, current_session_id: sessions[sessions.length - 1], entrypoint: 'cli',
    sessions: sessions.map((s, i) => ({
      session_id: s, slug: w.ch.slug, reason: i === 0 ? 'start' : 'clear', started_at: created + i,
      ended_at: i < sessions.length - 1 ? created + i + 1 : null,
    })),
    process: live ? {
      pid: LIVE_PID, proc_start: null, kind: 'interactive', entrypoint: 'cli', cc_version: '2.1.287',
      linked_by: 'hook', linked_at: created, left_by: null,
    } : null,
  };
}

function writeRegistry(w, list) {
  const file = projectPaths(w.root).mirrorConversations;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { v: 1, conversations: list });
}

// The real index store, its loads counted; `hold(sid)` makes that session's
// next load wait until the promise it answers is resolved by `release()`.
function countingStore() {
  const loads = [];
  const held = new Map();
  const create = (opts) => {
    const s = createIndexStore(opts);
    return {
      async load(id, o) {
        loads.push(id);
        const gate = held.get(id);
        if (gate) { held.delete(id); await gate.promise; }
        return s.load(id, o);
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
    const promise = new Promise((r) => { release = r; });
    held.set(id, { promise });
    return release;
  };
  return { create, loads, hold };
}

// A real facade over the world: the real SOURCES, the transcripts source over
// the counting store, and a recorder source (its engine, the turns it saw open).
function boot(t, w, { store = countingStore(), parsedMax, conversationsOptions } = {}) {
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 5000 });
  const frames = [];
  mirrorBus.setBroadcaster((f) => frames.push(f));
  const rec = { engine: null, opened: [] };
  const sources = [
    ...SOURCES.map((s) => (s.name === 'transcripts'
      ? { name: 'transcripts', attach: createTranscriptsSource({ createStore: store.create, pollMs: 40 }).attach }
      : s)),
    {
      name: 'recorder',
      attach: (engine) => {
        rec.engine = engine;
        return { start: async () => {}, stop: async () => {}, onTurnOpened: (turn) => rec.onOpen && rec.onOpen(turn) };
      },
    },
  ];
  const mirror = createMirror({
    root: w.root, graph: w.graph, hooks, mainBus: w.bus, mirrorBus, redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources,
    ...(parsedMax ? { parsedMax } : {}),
    ...(conversationsOptions ? { conversationsOptions } : {}),
  });
  let stopped = false;
  const h = { mirror, store, hooks, frames, rec, w };
  h.stop = async () => { if (!stopped) { stopped = true; await mirror.stop(); } };
  t.after(() => h.stop());
  let ts = Date.now();
  h.env = (event, s, extra = {}) => ({
    v: 1, event, ts: ++ts, session_id: s, transcript_path: w.ch.transcript(s), cwd: w.ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, s, extra) => hooks.publish(h.env(event, s, extra));
  // since 0: the snapshot lists the last day's conversations by default.
  h.conv = (cid) => mirror.snapshot({ since: 0 }).conversations.find((c) => c.id === cid) || null;
  h.ids = async (cid) => {
    const p = await mirror.turns(cid, { limit: 100 });
    return p && Array.isArray(p.turns) ? p.turns.map((x) => x.id) : p;
  };
  h.lazy = () => mirror.snapshot({}).diagnostics.lazy;
  return h;
}

const sorted = (a) => [...a].sort();
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// ── boot: the eager set ──────────────────────────────────────────────────────

test('a 50-conversation registry boots loading exactly the eager five: the live one, its fork source, three active after the newest node; 45 listed with no turns', async (t) => {
  const w = world(t);
  const cutoff = w.cutoff();
  assert.ok(Number.isFinite(cutoff), 'the graph has a node');
  const ids = Array.from({ length: 50 }, (_, i) => sid(i + 1));
  const old = cutoff - 2 * DAY;
  const list = ids.map((id, i) => {
    transcript(w, id, [`t-${i}`], old + i * 1000);
    if (i === 0) return stored(w, { id, lastActivity: old, live: true, forkedFrom: ids[1] });
    if (i >= 2 && i <= 4) return stored(w, { id, lastActivity: cutoff + 1000 * i });
    return stored(w, { id, lastActivity: old + i * 1000 });
  });
  writeRegistry(w, list);
  const h = boot(t, w);
  await h.mirror.start();
  const eager = ids.slice(0, 5);
  await waitUntil(() => eager.every((id) => (h.conv(id) || {}).turn_count === 1), { timeout: 15000, what: 'the eager five parsed' });
  await settle();
  assert.deepEqual(sorted(h.store.loads), sorted(eager), 'store.load for exactly the eager five\'s sessions');
  const snap = h.mirror.snapshot({ since: 0 });
  assert.equal(snap.conversations.length, 50, 'every conversation is listed');
  for (const id of ids.slice(5)) assert.equal(h.conv(id).turn_count, 0, `${id} listed with no turns`);
  assert.deepEqual(snap.diagnostics.lazy, { listed: 45, parsed: 5, indexing: 0 });
  assert.equal(h.rec.engine.indexing(ids[9]), true, 'a listed conversation reads indexing');
  assert.equal(h.rec.engine.indexing(ids[0]), false, 'an eager one does not');
});

test('a graph with no node: every conversation is eager', async (t) => {
  const w = world(t, { nodes: 0 });
  assert.equal(w.cutoff(), null);
  const ids = Array.from({ length: 6 }, (_, i) => sid(i + 1, 1));
  const old = Date.now() - 30 * DAY;
  writeRegistry(w, ids.map((id, i) => { transcript(w, id, [`n-${i}`], old + i); return stored(w, { id, lastActivity: old + i }); }));
  const h = boot(t, w);
  await h.mirror.start();
  await waitUntil(() => ids.every((id) => (h.conv(id) || {}).turn_count === 1), { timeout: 15000, what: 'all six parsed' });
  assert.deepEqual(sorted(h.store.loads), sorted(ids));
  assert.deepEqual(h.lazy(), { listed: 0, parsed: 6, indexing: 0 });
});

// ── first use ────────────────────────────────────────────────────────────────

test('a first turns(cid) of a listed conversation loads its sessions once and answers its turns; a second loads nothing', async (t) => {
  const w = world(t);
  const old = w.cutoff() - 2 * DAY;
  const [a, a2, b] = [sid(1, 2), sid(2, 2), sid(3, 2)];
  transcript(w, a, ['a-1', 'a-2'], old);
  transcript(w, a2, ['a-3'], old + 5000);
  transcript(w, b, ['b-1'], old);
  writeRegistry(w, [stored(w, { id: a, sessions: [a, a2], lastActivity: old + 6000 }), stored(w, { id: b, lastActivity: old })]);
  const h = boot(t, w);
  await h.mirror.start();
  await settle();
  assert.deepEqual(h.store.loads, [], 'nothing parsed at boot');
  assert.equal(h.conv(a).turn_count, 0);
  assert.deepEqual(await h.ids(a), ['a-1', 'a-2', 'a-3'], 'the first read parses, then answers');
  assert.deepEqual(h.store.loads, [a, a2], 'each of its sessions loaded once, in order');
  assert.equal(h.rec.engine.indexing(a), false, 'parsed now');
  assert.equal(h.rec.engine.indexing(b), true, 'the other stays listed');
  assert.deepEqual(await h.ids(a), ['a-1', 'a-2', 'a-3']);
  assert.deepEqual(h.store.loads, [a, a2], 'a second read loads nothing');
  assert.deepEqual(h.lazy(), { listed: 1, parsed: 1, indexing: 0 });
});

test('a list never parses: snapshot(), the graph\'s marks and the status rows read no index', async (t) => {
  const w = world(t);
  const old = w.cutoff() - 2 * DAY;
  const a = sid(1, 3);
  transcript(w, a, ['l-1'], old);
  writeRegistry(w, [stored(w, { id: a, lastActivity: old })]);
  const h = boot(t, w);
  await h.mirror.start();
  h.mirror.snapshot({ since: 0 });
  h.mirror.nodeSummaries();
  h.mirror.summary();
  await settle();
  assert.deepEqual(h.store.loads, []);
});

// ── load-then-tail (R2) ──────────────────────────────────────────────────────

test('a resumed old session: the rewind its index persisted is in the model before the first new record\'s turn opens', async (t) => {
  const w = world(t, { nodes: 0 });
  const s = sid(1, 4);
  const at = Date.now() - 3 * DAY;
  const fx = branch({ sessionId: s, cwd: w.ch.cwd, start: at, hooks: false });
  w.ch.writeTranscript(s, fx.records);
  writeRegistry(w, [stored(w, { id: s, lastActivity: at })]);
  // First daemon: no node yet, so it parses everything and writes the index.
  const first = boot(t, w);
  await first.mirror.start();
  await waitUntil(async () => {
    const p = await first.mirror.turns(s, { limit: 100 });
    return p && fx.expect.superseded.every((id) => (p.turns.find((x) => x.id === id) || {}).superseded === true);
  }, { timeout: 15000, what: 'the rewind in the first daemon' });
  await first.stop();
  const ix = JSON.parse(fs.readFileSync(projectPaths(w.root).mirrorIndex(s), 'utf8'));
  assert.ok(ix.turns.some((x) => x.internal && x.internal.rewind), 'the index persisted the rewind');

  // A node now: the conversation is old, so the second daemon only lists it.
  w.commit();
  const h = boot(t, w);
  const seen = [];
  h.rec.onOpen = (turn) => {
    if (turn.id !== 'resumed-1') return;
    const m = h.rec.engine.model;
    seen.push(fx.expect.superseded.map((id) => (m.turn(id) || {}).superseded === true));
  };
  await h.mirror.start();
  await settle();
  assert.deepEqual(h.store.loads, [], 'listed, not parsed');
  // The resume: Claude Code links a process to the session again, then writes.
  h.publish('SessionStart', s, { session: { source: 'resume' }, claude_pid: LIVE_PID });
  const before = fx.records.length;
  closedTurn(fx.r, 'resumed-1');
  w.ch.appendTranscript(s, fx.r.records.slice(before));
  await waitUntil(() => seen.length > 0, { timeout: 15000, what: 'the new turn to open' });
  assert.deepEqual(seen[0], fx.expect.superseded.map(() => true), 'superseded before the new turn opened');
  assert.deepEqual(h.store.loads, [s], 'the index was loaded first');
  const p = await h.mirror.turns(s, { limit: 100 });
  assert.deepEqual(p.turns.map((x) => x.id), [...fx.turns, 'resumed-1']);
});

// ── forks (R4) ───────────────────────────────────────────────────────────────

test('a fork whose source is listed: ensureConversation(fork) loads the source first, and the copied openers stay the source\'s', async (t) => {
  const w = world(t);
  const old = w.cutoff() - 2 * DAY;
  const src = sid(1, 5);
  const fork = sid(2, 5);
  const r1 = transcript(w, src, ['src-1', 'src-2'], old);
  // The fork's file: the source's records copied under the fork's session id, then its own turn.
  const copied = r1.records.map((x) => (x.sessionId ? { ...x, sessionId: fork } : x));
  const r3 = createRecords({ seed: nextSeed++, sessionId: fork, cwd: w.ch.cwd, start: old + 60000, step: 10 });
  closedTurn(r3, 'fork-own-1');
  w.ch.writeTranscript(fork, [...copied, ...r3.records]);
  writeRegistry(w, [stored(w, { id: src, lastActivity: old + 100 }), stored(w, { id: fork, lastActivity: old + 70000, forkedFrom: src })]);
  const h = boot(t, w);
  await h.mirror.start();
  await settle();
  assert.deepEqual(h.store.loads, []);
  assert.equal(h.rec.engine.indexing(fork), true);
  assert.deepEqual(await h.rec.engine.ensureConversation(fork), { ok: true });
  assert.deepEqual(h.store.loads, [src, fork], 'the source first');
  assert.deepEqual(await h.ids(fork), ['fork-own-1'], 'the fork has only its own turn');
  assert.deepEqual(await h.ids(src), ['src-1', 'src-2'], 'the copies are the source\'s');
  assert.deepEqual(h.store.loads, [src, fork], 'and reading both loads nothing more');
});

// ── the toggle (R5) ──────────────────────────────────────────────────────────

test('the toggle: an ensureConversation waiting across a switch-off resolves unavailable and the turns route answers 503; the switch-on opens only the eager set', async (t) => {
  const w = world(t);
  const cutoff = w.cutoff();
  const old = cutoff - 2 * DAY;
  const [live, a, b] = [sid(1, 6), sid(2, 6), sid(3, 6)];
  transcript(w, live, ['live-1'], old);
  transcript(w, a, ['a-1'], old);
  transcript(w, b, ['b-1'], old);
  writeRegistry(w, [
    stored(w, { id: live, lastActivity: old, live: true }),
    stored(w, { id: a, lastActivity: old }),
    stored(w, { id: b, lastActivity: old }),
  ]);
  const store = countingStore();
  const h = boot(t, w, { store, conversationsOptions: { discoveryMs: 40 } });
  await h.mirror.start();
  await waitUntil(() => (h.conv(live) || {}).turn_count === 1, { timeout: 15000, what: 'the live one parsed' });
  assert.deepEqual(store.loads, [live]);

  // A turns route over the facade, asked while a's parse is held.
  const app = express();
  mountMirrorContentRoutes(app, { mirror: h.mirror, audience: createAudience({ configFile: null }) });
  const srv = http.createServer(app);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => { srv.closeAllConnections(); srv.close(res); }));
  const release = store.hold(a);
  t.after(() => release());
  const waiting = h.rec.engine.ensureConversation(a);
  const asked = request(srv.address().port, 'GET', `/api/mirror/conversations/${a}/turns`, null, { timeout: 20000 });
  await waitUntil(() => store.loads.includes(a), { timeout: 5000, what: 'a\'s parse to be waiting' });
  assert.equal(h.rec.engine.indexing(a), true, 'indexing while its parse runs');

  const flag = projectPaths(w.root).disabled;
  fs.writeFileSync(flag, '');
  assert.deepEqual(await waiting, { ok: false, unavailable: true }, 'resolved, never hung');
  const res = await asked;
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { ok: false, unavailable: true });
  release();

  const loadsBefore = store.loads.length;
  fs.rmSync(flag);
  await waitUntil(() => h.mirror.enabled().enabled === true, { timeout: 10000, what: 'switched on' });
  await waitUntil(() => (h.conv(live) || {}).turn_count === 1, { timeout: 15000, what: 'the live one parsed again' });
  await settle();
  assert.deepEqual(store.loads.slice(loadsBefore), [live], 'only the eager set opened again');
  assert.equal(h.conv(a).turn_count, 0, 'a is listed again');
  assert.deepEqual(h.lazy(), { listed: 2, parsed: 1, indexing: 0 });
});

// ── unloaded (R1) ────────────────────────────────────────────────────────────

test('unloaded at parsedMax 1: the index keeps every turn; turns(cid) and turn(id) parse again and answer the same ids', async (t) => {
  const w = world(t);
  const old = w.cutoff() - 2 * DAY;
  const [a, b] = [sid(1, 7), sid(2, 7)];
  transcript(w, a, ['a-1', 'a-2', 'a-3'], old);
  transcript(w, b, ['b-1', 'b-2'], old);
  writeRegistry(w, [stored(w, { id: a, lastActivity: old }), stored(w, { id: b, lastActivity: old })]);
  const h = boot(t, w, { parsedMax: 1 });
  await h.mirror.start();
  assert.deepEqual(await h.ids(a), ['a-1', 'a-2', 'a-3']);
  assert.deepEqual(await h.ids(b), ['b-1', 'b-2']);
  assert.equal(h.conv(a).turn_count, 3, 'the count it held');
  assert.equal(h.rec.engine.model.turnsOf(a).length, 0, 'a was unloaded');
  assert.equal(h.rec.engine.indexing(a), true, 'listed again');
  const ix = JSON.parse(fs.readFileSync(projectPaths(w.root).mirrorIndex(a), 'utf8'));
  assert.deepEqual(ix.turns.map((x) => x.id), ['a-1', 'a-2', 'a-3'], 'the index on disk holds every turn');

  assert.deepEqual(await h.ids(a), ['a-1', 'a-2', 'a-3'], 'turns(a) parses again');
  assert.deepEqual(h.store.loads, [a, b, a]);
  assert.equal(h.rec.engine.model.turnsOf(b).length, 0, 'b was unloaded in its turn');
  const one = await h.mirror.turn('b-2');
  assert.equal(one.turn.id, 'b-2', 'turn(id) of an unloaded turn parses again and answers');
  assert.deepEqual(h.store.loads, [a, b, a, b]);
  assert.equal(await h.mirror.turn('never-seen'), null, 'an id nobody knows answers null');
});

test('a hook envelope for an unloaded conversation reopens it as its new turn opens: its turn_count holds (K.2-161)', async (t) => {
  const w = world(t);
  const old = w.cutoff() - 2 * DAY;
  const [a, b] = [sid(1, 8), sid(2, 8)];
  transcript(w, a, ['a-1', 'a-2'], old);
  transcript(w, b, ['b-1'], old);
  writeRegistry(w, [stored(w, { id: a, lastActivity: old }), stored(w, { id: b, lastActivity: old })]);
  const h = boot(t, w, { parsedMax: 1 });
  await h.mirror.start();
  await h.ids(a);
  await h.ids(b);
  assert.equal(h.rec.engine.model.turnsOf(a).length, 0, 'a was unloaded');
  assert.equal(h.conv(a).turn_count, 2);
  h.publish('UserPromptSubmit', a, { prompt_id: 'a-new', prompt: { author: 'user', text: 'again' } });
  await waitUntil(() => h.rec.engine.model.turnsOf(a).length === 3, { timeout: 10000, what: 'a reopened with its new turn' });
  assert.equal(h.conv(a).turn_count, 3, 'two restored and the new one');
  assert.deepEqual(h.rec.engine.model.turnsOf(a).map((x) => x.id), ['a-1', 'a-2', 'a-new']);
});

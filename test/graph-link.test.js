// The graph link (spec §2.8, §2.12, §15.4; U44): each closed chat turn and the
// graph node it rode into.
//
// Three rigs, in the order the brief asks for them:
//   * the source on an engine built from the mirror's real model and turn
//     machine (no facade), over a graph from lib/server/graph createGraph, with
//     graph.mirror pointing at the source's attachToNode and commits made by
//     domain/turns commitNode — the rules: attach, the commit match, the label,
//     the orphans, the boot rebuild, nodeTurns and summaries;
//   * a real facade (lib/server/mirror createMirror, with `live` and this source
//     registered) under the graph routes on a BARE Express app whose ctx carries
//     the hook tap and the real audience, the turn routes posted through
//     lib/client as the host — every commit path, the orphans through the
//     routes, the read boundary;
//   * the documents that draw a node: previewNodeJson, GET /preview/node/:id,
//     the export and the replay carry no `mirror`, and GET /api/graph/node/:id
//     drops it below read.
// And the graph-level stop that clears a held lock's stale timer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createHook } = require('async_hooks');
const express = require('express');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, tmpRoot } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { request } = require('../lib/client');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { resolvePaths } = require('../lib/server/paths');
const { createState } = require('../lib/server/state');
const { createGraph, computeLabels } = require('../lib/server/graph');
const { createHookTap } = require('../lib/server/hook-tap');
const { createAudience } = require('../lib/server/audience');
const { mountGraphRoutes } = require('../lib/server/routes/graph');
const turns = require('../lib/server/domain/turns');
const { previewNodeJson } = require('../lib/server/preview');
const { buildExportHtml, nodeForExport } = require('../lib/server/export');
const { buildReplay, resolveReplay } = require('../lib/server/replay/document');
const { createModel } = require('../lib/server/mirror/model');
const { createTurnMachine } = require('../lib/server/mirror/turn-machine');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createGraphLinkSource, SOURCE_NAME } = require('../lib/server/mirror/graph-link');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const REF_KEYS = ['conversation_id', 'from', 'role', 'seq', 'session_id', 'to', 'turn_id'];
// The keys a node committed before 0.8.5's graph link carries (no markdown, no
// bookmark, nothing folded): what commitNode writes with no graph.mirror.
const NODE_KEYS_0_8_2 = ['author', 'captures', 'comments', 'created_at', 'id', 'mounts', 'parent_id', 'store', 'trigger'];

// A redactor that masks one sentinel: enough for the model's inbound scrub.
const SENTINEL_REDACTOR = {
  text: (s) => s.replace(/SECRET[A-Za-z0-9_]*/g, '[MASK]'),
  value: (v) => JSON.parse(JSON.stringify(v).replace(/SECRET[A-Za-z0-9_]*/g, '[MASK]')),
};

// ── rig 1: the source over the real model and turn machine ──────────────────

function graphFor(root) {
  const paths = resolvePaths(root);
  const state = createState();
  const graph = createGraph({ paths, state, draftPath: projectPaths(root).draft });
  graph.load();
  return { paths, state, graph };
}

// The engine a source is handed, less what this source does not read. The
// model's members and the turn machine's graph-link operations, under the names
// the facade gives them (lib/server/mirror/index.js sourceModel).
function rig(t, { start = true } = {}) {
  const root = tmpRoot('wc-glink-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { paths, state, graph } = graphFor(root);
  const bus = createBus();
  let clock = Date.now();
  const model = createModel({ redactor: SENTINEL_REDACTOR });
  const tm = createTurnMachine({ model, now: () => clock });
  const sourceModel = {
    ...model,
    openTurn: tm.openTurn, closeTurn: tm.closeTurn, supersede: tm.supersede, openTurnOf: tm.openTurnOf,
    resolveTurn: tm.resolve, segmentOf: tm.segmentOf, pendingTurns: tm.pendingTurns, attachTurn: tm.attach,
    orphanPending: tm.orphanPending, linkState: tm.linkState, exportTurns: tm.exportTurns, restoreTurns: tm.restoreTurns,
  };
  const logs = [];
  const engine = {
    name: SOURCE_NAME, root, now: () => clock, log: (m) => logs.push(m), model: sourceModel, graph,
    mainBus: { subscribe: (fn) => bus.subscribe(fn), read: (q) => bus.read(q) },
  };
  const source = createGraphLinkSource().attach(engine);
  graph.mirror = { attachToNode: (...a) => source.api.attachToNode(...a) };
  const r = {
    root, paths, state, graph, bus, model, tm, source, logs,
    api: source.api,
    tick: (ms = 1) => { clock += ms; return clock; },
    now: () => clock,
    // A hook envelope into the turn machine (the conversation is the session).
    hook(sid, event, fields = {}) {
      clock += 1;
      return tm.ingest(sid, { v: 1, event, ts: clock, session_id: sid, transcript_path: `/p/${sid}.jsonl`, cwd: '/p', prompt_id: null, ...fields });
    },
    // A whole turn by its hooks: UserPromptSubmit, then Stop.
    turn(sid, pid, text = `prompt ${pid}`) {
      r.hook(sid, 'UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text } });
      r.hook(sid, 'Stop', { prompt_id: pid, stop: { last_assistant_message: 'done' } });
    },
    // A whole turn read from the transcript, with byte offsets: its segment.
    txTurn(sid, pid, from, to) {
      clock += 1;
      const ts = clock;
      const mid = Math.floor((from + to) / 2);
      tm.applyChanges(sid, sid, [
        { type: 'opener', prompt_id: pid, uuid: `${pid}-a`, parent_uuid: null, kind: 'prompt', text: `prompt ${pid}`, ts, offset: { start: from, end: mid } },
        { type: 'item', uuid: `${pid}-b`, parent_uuid: `${pid}-a`, ts, item: { id: `r_${pid}`, kind: 'reply', text: 'ok' }, offset: { start: mid, end: to - 1 } },
        { type: 'turn-duration', uuid: `${pid}-c`, parent_uuid: `${pid}-b`, duration_ms: 5, ts, offset: { start: to - 1, end: to } },
      ]);
    },
    dirty(k = 'k') { state.store[k] = clock++; },
    // A commit as the routes make it: turn-end ('turn-end', with the Stop's
    // session) or a manual one / a preserve ('commit').
    commit({ op = 'turn-end', session_id, prompt_id, parentId } = {}) {
      r.dirty();
      return turns.commitNode(graph, bus, {
        draftPath: graph.draftPath, parentId: parentId === undefined ? graph.active : parentId, author: 'claude',
        triggerKind: op === 'turn-end' ? 'turn' : 'manual', message: 'm', clearLock: false, op,
        includeLabelAndUnlock: op === 'turn-end', session_id, prompt_id,
      }).node_id;
    },
    nodeFile: (id) => JSON.parse(fs.readFileSync(path.join(paths.GRAPH_DIR, `${id}.json`), 'utf8')),
    label: (id) => computeLabels(graph).get(id),
  };
  if (start) {
    const started = source.start();
    t.after(() => source.stop());
    return started.then(() => r);
  }
  t.after(() => source.stop());
  return Promise.resolve(r);
}

const roleOf = (node) => Object.fromEntries((node.mirror ? node.mirror.turns : []).map((x) => [x.turn_id, x.role]));

// ── attach ───────────────────────────────────────────────────────────────────

test('attach: two closed turns of one session and one of another become the node\'s mirror.turns — the Stop\'s turn commit, the others folded', async (t) => {
  const r = await rig(t);
  r.txTurn(S1, 'pA', 0, 100);
  r.txTurn(S2, 'qA', 0, 80);
  r.txTurn(S1, 'pB', 100, 260);
  assert.deepEqual(r.tm.pendingTurns().map((x) => x.id).sort(), ['pA', 'pB', 'qA'], 'three closed, unattached turns');

  const id = r.commit({ session_id: S1, prompt_id: 'pB' });
  const node = r.nodeFile(id);
  assert.equal(node.mirror.v, 1);
  assert.deepEqual(node.mirror.turns, [
    { conversation_id: S1, session_id: S1, turn_id: 'pA', seq: 1, role: 'folded', from: 0, to: 100 },
    { conversation_id: S1, session_id: S1, turn_id: 'pB', seq: 2, role: 'commit', from: 100, to: 260 },
    { conversation_id: S2, session_id: S2, turn_id: 'qA', seq: 1, role: 'folded', from: 0, to: 80 },
  ], 'ordered by conversation, then seq; references only');
  for (const ref of node.mirror.turns) assert.deepEqual(Object.keys(ref).sort(), REF_KEYS);
  assert.deepEqual(r.graph.nodes.get(id).mirror, node.mirror, 'the registered node is the written one');

  const label = r.label(id);
  const pB = r.model.serializeTurn('pB');
  assert.deepEqual(pB.node, { id, label, role: 'commit' });
  assert.equal(pB.folded_into, null, 'the commit turn rode into nothing');
  for (const tid of ['pA', 'qA']) {
    const h = r.model.serializeTurn(tid);
    assert.deepEqual(h.node, { id, label, role: 'folded' });
    assert.deepEqual(h.folded_into, { id, label });
  }
  for (const tid of ['pA', 'pB', 'qA']) assert.equal(r.tm.linkState(tid), 'attached');
  assert.deepEqual(r.tm.pendingTurns(), [], 'nothing left pending');
});

test('a turn with no transcript segment yet carries no from/to: the transcript lags a Stop by about a record', async (t) => {
  const r = await rig(t);
  r.turn(S1, 'pA');
  const id = r.commit({ session_id: S1, prompt_id: 'pA' });
  assert.deepEqual(r.nodeFile(id).mirror.turns, [{ conversation_id: S1, session_id: S1, turn_id: 'pA', seq: 1, role: 'commit' }]);
});

// ── the commit match ─────────────────────────────────────────────────────────

test('the commit match: by the turn\'s id or the hook id its header `replaces`; nothing else is inferred', async (t) => {
  const r = await rig(t);
  // A hook turn the transcript's opener binds by order under its own id: the
  // header says `replaces: 'hookP'`, and the Stop still names 'hookP'.
  r.hook(S1, 'UserPromptSubmit', { prompt_id: 'hookP', prompt: { author: 'user', text: 'bind me' } });
  r.tick();
  r.tm.applyChanges(S1, S1, [{ type: 'opener', prompt_id: 'txP', uuid: 'u1', parent_uuid: null, kind: 'prompt', text: 'bind me', ts: r.now() }]);
  r.hook(S1, 'Stop', { prompt_id: 'hookP', stop: { last_assistant_message: 'ok' } });
  const bound = r.tm.pendingTurns()[0];
  assert.equal(bound.id, 'txP');
  assert.equal(bound.replaces, 'hookP');
  const id = r.commit({ session_id: S1, prompt_id: 'hookP' });
  assert.deepEqual(roleOf(r.nodeFile(id)), { txP: 'commit' });
});

test('the commit match: a prompt_id that names no pending turn (an absorbed prompt) gives no turn commit — every turn folded (held: U44@commit-match-fallback)', async (t) => {
  const r = await rig(t);
  r.turn(S1, 'pA');
  r.turn(S1, 'pB');
  const id = r.commit({ session_id: S1, prompt_id: 'p-absorbed' });
  assert.deepEqual(roleOf(r.nodeFile(id)), { pA: 'folded', pB: 'folded' });
});

test('the commit match: a commit with no session, or a session with no pending turn, makes every turn folded', async (t) => {
  const r = await rig(t);
  r.turn(S1, 'pA');
  const manual = r.commit({ op: 'commit' });
  assert.deepEqual(roleOf(r.nodeFile(manual)), { pA: 'folded' }, 'no session: a manual commit or a preserve');
  r.turn(S1, 'pB');
  const other = r.commit({ session_id: S2, prompt_id: 'pB' });
  assert.deepEqual(roleOf(r.nodeFile(other)), { pB: 'folded' }, 'the Stop\'s session has no pending turn');
  r.turn(S1, 'pC');
  const noPrompt = r.commit({ session_id: S1 });
  assert.deepEqual(roleOf(r.nodeFile(noPrompt)), { pC: 'folded' }, 'a session with no prompt_id names no turn');
});

// ── the node file's shape ────────────────────────────────────────────────────

test('no pending turn → the node file has no mirror key; graph.mirror unset → the node is a 0.8.2 node, keys and values', async (t) => {
  const r = await rig(t);
  const quiet = r.commit({ session_id: S1, prompt_id: 'pA' });
  assert.equal('mirror' in r.nodeFile(quiet), false, 'attachToNode answered null');

  // The same commit with no graph.mirror at all, and pending turns that stay so.
  r.turn(S1, 'pA');
  delete r.graph.mirror;
  r.state.store = {};
  const id = r.commit({ op: 'commit' });
  const file = r.nodeFile(id);
  assert.deepEqual(Object.keys(file).sort(), NODE_KEYS_0_8_2);
  assert.deepEqual(file, {
    id, parent_id: quiet, created_at: file.created_at, author: 'claude',
    trigger: { kind: 'manual', message: 'm', summary: 'm' },
    mounts: [], store: { k: file.store.k }, comments: [], captures: [],
  });
  assert.equal(r.tm.linkState('pA'), 'pending', 'nothing attached it');
});

test('an {unavailable: true} answer, a non-plain or empty answer, and a throwing attachToNode leave no key, and the commit succeeds', async (t) => {
  const r = await rig(t);
  const answers = [
    () => ({ unavailable: true }),
    () => ({ v: 1, turns: [] }),
    () => [{ turn_id: 'x' }],
    () => Object.assign(Object.create({ inherited: true }), { v: 1, turns: [{ turn_id: 'x' }] }),
    () => { throw new TypeError('boom'); },
  ];
  for (const answer of answers) {
    r.graph.mirror = { attachToNode: answer };
    const before = r.graph.nodes.size;
    const id = r.commit({ session_id: S1, prompt_id: 'pA' });
    assert.equal(r.graph.nodes.size, before + 1, 'the node is committed');
    assert.equal(r.graph.active, id);
    assert.equal('mirror' in r.nodeFile(id), false);
  }
});

// ── the label ────────────────────────────────────────────────────────────────

test('the label: once the commit\'s graph event has gone out, every attached header reads computeLabels\' label, not the stored id', async (t) => {
  const r = await rig(t);
  r.commit({ op: 'commit' }); // n0 → n1.0
  r.turn(S1, 'pA');
  r.turn(S2, 'qA');
  const seen = [];
  r.bus.subscribe((e) => {
    if (e.kind === 'graph') seen.push([e.op, r.model.serializeTurn('pA').node && r.model.serializeTurn('pA').node.label]);
  });
  const id = r.commit({ session_id: S1, prompt_id: 'pA' });
  const label = r.label(id);
  assert.match(label, /^n1\.\d+$/);
  assert.notEqual(label, id, 'the stored id is not the label');
  assert.deepEqual(seen, [['turn-end', label]], 'relabelled by the time the commit\'s event has reached its subscribers');
  for (const tid of ['pA', 'qA']) assert.equal(r.model.serializeTurn(tid).node.label, label);
  assert.equal(r.model.serializeTurn('qA').folded_into.label, label);

  // A preserve (op 'commit') is relabelled the same way.
  r.turn(S1, 'pB');
  const preserve = r.commit({ op: 'commit' });
  assert.equal(r.model.serializeTurn('pB').node.label, r.label(preserve));
  assert.notEqual(r.label(preserve), preserve);
});

// ── orphans ──────────────────────────────────────────────────────────────────

test('orphans: set-active with nothing preserved and new-graph orphan the pending turns, the next commit leaves them; a wipe changes nothing', async (t) => {
  const r = await rig(t);
  r.turn(S1, 'pA');
  r.bus.emit({ event: { kind: 'graph', op: 'wipe' } });
  assert.equal(r.tm.linkState('pA'), 'pending', 'a wipe stays on the node');
  r.bus.emit({ event: { kind: 'graph', op: 'set-active', id: 'n9', preserved: 'n8' } });
  assert.equal(r.tm.linkState('pA'), 'pending', 'a set-active whose dirty work was preserved orphans nothing');
  r.bus.emit({ event: { kind: 'graph', op: 'set-active', id: 'n9' } });
  assert.equal(r.tm.linkState('pA'), 'orphaned');
  r.turn(S1, 'pB');
  r.bus.emit({ event: { kind: 'graph', op: 'new-graph', name: 'fresh' } });
  assert.equal(r.tm.linkState('pB'), 'orphaned');
  r.turn(S1, 'pC');
  const id = r.commit({ session_id: S1, prompt_id: 'pC' });
  assert.deepEqual(roleOf(r.nodeFile(id)), { pC: 'commit' }, 'the orphans never attach');
  assert.equal(r.model.serializeTurn('pA').node, null);
});

// ── the boot rebuild ─────────────────────────────────────────────────────────

// A turn the index restores: closed, unattached, ended at `ended_at`.
const restored = (sid, id, seq, ended_at, link = 'pending') => ({
  header: { id, conversation_id: sid, session_id: sid, seq, kind: 'prompt', author: 'user', status: 'done', started_at: ended_at - 10, ended_at },
  internal: { link, bound: true },
});

function nodeAt(id, parent_id, created_at, mirror) {
  return {
    id, parent_id, created_at, author: 'claude', trigger: { kind: 'turn', message: '', summary: '' },
    mounts: [], store: {}, comments: [], captures: [], ...(mirror ? { mirror } : {}),
  };
}

test('the boot rebuild: a node\'s mirror.turns re-attaches the same pending turn to that node and role; older pending turns are orphans, newer stay pending', async (t) => {
  const r = await rig(t, { start: false });
  const base = Date.now() - 100000;
  r.graph.registerNode(nodeAt('n0', null, base));
  r.graph.registerNode(nodeAt('n1', 'n0', base + 1000, { v: 1, turns: [
    { conversation_id: S1, session_id: S1, turn_id: 'pA', seq: 1, role: 'commit' },
    { conversation_id: S1, session_id: S1, turn_id: 'pB', seq: 2, role: 'folded' },
  ] }));
  r.graph.registerNode(nodeAt('n2', 'n1', base + 1200, { v: 1, turns: [{ conversation_id: S2, session_id: S2, turn_id: 'qA', seq: 1, role: 'folded' }] }));
  r.graph.active = 'n2';
  r.tm.restoreTurns(S1, [
    restored(S1, 'pA', 1, base + 900), // the index is older than the node file: still pending
    restored(S1, 'pB', 2, base + 950),
    restored(S1, 'pOld', 3, base + 990), // ended before the newest node, recorded nowhere
    restored(S1, 'pNew', 4, base + 1500), // ended after it (n2, base + 1200): waits for the next commit
  ]);
  await r.source.start();
  assert.deepEqual(r.model.serializeTurn('pA').node, { id: 'n1', label: r.label('n1'), role: 'commit' });
  assert.deepEqual(r.model.serializeTurn('pB').node, { id: 'n1', label: r.label('n1'), role: 'folded' });
  assert.deepEqual(r.model.serializeTurn('pB').folded_into, { id: 'n1', label: 'n1.1' });
  assert.equal(r.tm.linkState('pOld'), 'orphaned');
  assert.equal(r.tm.linkState('pNew'), 'pending');

  // A turn restored after start() — the transcripts source restores its index
  // then — is reconciled at the next api call: one a node records, one that
  // ended before the cutoff, one after it.
  r.tm.restoreTurns(S2, [restored(S2, 'qA', 1, base + 1100), restored(S2, 'qEarly', 2, base + 1150), restored(S2, 'qLate', 3, base + 1300)]);
  assert.equal(r.tm.linkState('qA'), 'pending', 'not yet');
  const live = r.api.nodeTurns('live');
  assert.equal(r.tm.linkState('qA'), 'attached');
  assert.deepEqual(r.model.serializeTurn('qA').node, { id: 'n2', label: r.label('n2'), role: 'folded' });
  assert.equal(r.tm.linkState('qEarly'), 'orphaned', 'it ended before the newest node');
  assert.equal(r.tm.linkState('qLate'), 'pending', 'it ended after it');
  assert.deepEqual(live.turns.map((x) => x.id), ['qLate', 'pNew'], 'the pending turns, the oldest-ended first');
});

test('a batch another source applies runs the reconcile too (onChanges)', async (t) => {
  const r = await rig(t, { start: false });
  const base = Date.now() - 100000;
  r.graph.registerNode(nodeAt('n0', null, base, { v: 1, turns: [{ conversation_id: S1, session_id: S1, turn_id: 'pA', seq: 1, role: 'commit' }] }));
  await r.source.start();
  r.tm.restoreTurns(S1, [restored(S1, 'pA', 1, base - 5)]);
  r.source.onChanges(S1, [{ type: 'record', uuid: 'x' }], { conversation_id: S1 });
  assert.deepEqual(r.model.serializeTurn('pA').node, { id: 'n0', label: 'n1.0', role: 'commit' });
});

// ── nodeTurns ────────────────────────────────────────────────────────────────

test('nodeTurns: by hierarchical label, stored id and active; an unknown ref → null; live → the pending turns; a turn the model lost → its stub', async (t) => {
  const r = await rig(t);
  r.commit({ op: 'commit' });
  r.turn(S1, 'pA', 'first');
  r.turn(S2, 'qA', 'second');
  const id = r.commit({ session_id: S1, prompt_id: 'pA' });
  const label = r.label(id);
  const byLabel = r.api.nodeTurns(label);
  assert.deepEqual(byLabel.node, { id, label });
  assert.deepEqual(byLabel.turns.map((x) => [x.id, x.role]), [['pA', 'commit'], ['qA', 'folded']]);
  const header = r.model.serializeTurn('pA');
  assert.deepEqual(byLabel.turns[0], { ...header, role: 'commit' }, 'the model\'s serialized header plus role');
  assert.deepEqual(r.api.nodeTurns(id), byLabel, 'by stored id');
  assert.deepEqual(r.api.nodeTurns('active'), byLabel, 'active');
  assert.equal(r.api.nodeTurns('n99'), null);
  assert.equal(r.api.nodeTurns('n7.7.7'), null);

  assert.deepEqual(r.api.nodeTurns(r.label('n0')), { node: { id: 'n0', label: 'n1.0' }, turns: [] }, 'a node with no mirror');

  r.turn(S1, 'pB');
  r.turn(S1, 'pC');
  const live = r.api.nodeTurns('live');
  assert.deepEqual(live.node, { id: 'live', label: 'live' });
  assert.deepEqual(live.turns.map((x) => x.id), ['pB', 'pC'], 'the pending turns, oldest first');

  r.tm.removeConversation(S2);
  const after = r.api.nodeTurns(id);
  assert.deepEqual(after.turns[1], { id: 'qA', conversation_id: S2, session_id: S2, seq: 1, role: 'folded', unavailable: true });
});

// ── summaries ────────────────────────────────────────────────────────────────

test('summaries: per-node turn counts; a supersede through the turn machine shows the superseded count and the rewound notice\'s at; a node without mirror is absent', async (t) => {
  const r = await rig(t);
  const plain = r.commit({ op: 'commit' });
  r.turn(S1, 'pA');
  r.turn(S1, 'pB');
  const first = r.commit({ session_id: S1, prompt_id: 'pB' });
  r.turn(S1, 'pC');
  r.turn(S2, 'qA');
  const second = r.commit({ session_id: S1, prompt_id: 'pC' });
  assert.deepEqual(r.api.summaries(), { nodes: { [first]: { turns: 2, superseded: 0 }, [second]: { turns: 2, superseded: 0 } } });
  assert.equal(plain in r.api.summaries().nodes, false);

  // A rewind back to pA's prompt: pB and pC are abandoned.
  const at = r.tick(10);
  const res = r.tm.supersede(S1, 'pB', { reason: 'branch', at, through: 'pC' });
  assert.deepEqual(res.superseded.sort(), ['pB', 'pC']);
  assert.equal(r.model.item('rw_pB').at, at);
  assert.deepEqual(r.api.summaries().nodes, {
    [first]: { turns: 2, superseded: 1, rewound_at: at },
    [second]: { turns: 2, superseded: 1, rewound_at: at },
  });
  // A second rewind further on: the newest `at` covering a node's turns wins.
  r.turn(S1, 'pD');
  const third = r.commit({ session_id: S1, prompt_id: 'pD' });
  const later = r.tick(10);
  r.tm.supersede(S1, 'pD', { reason: 'anchor', at: later, through: 'pD' });
  assert.deepEqual(r.api.summaries().nodes[third], { turns: 1, superseded: 1, rewound_at: later });
  assert.equal(r.nodeFile(first).mirror.turns.length, 2, 'a committed node is never rewritten');
});

// ── rig 2: a real facade under the graph routes ──────────────────────────────

const LIVE_ONLY = SOURCES.filter((s) => s.name === 'live');

async function routesRig(t, { redactor = createRedactor() } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  withTempHome(t);
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-glink-routes-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  const { paths, state, graph } = graphFor(root);
  const bus = createBus();
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 2000 });
  mirrorBus.setBroadcaster(() => {});
  mirror = createMirror({
    root, graph, hooks, mainBus: bus, mirrorBus, redactor, log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    sources: LIVE_ONLY,
  });
  mirror.register(SOURCE_NAME, createGraphLinkSource());
  await mirror.start();
  graph.mirror = mirror;

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const ctx = { graph, paths, state, bus, broadcastReset: () => {}, hooks, audience: createAudience({ configFile: null }) };
  mountGraphRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => { server.closeAllConnections(); server.close(res); }));
  const port = server.address().port;

  let ts = Date.now();
  const session = (sid, pid) => ({ session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd, prompt_id: pid });
  const env = (event, sid, extra = {}) => ({
    v: 1, event, ts: ++ts, session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  const h = {
    root, ch, ctx, graph, state, bus, hooks, mirror, port,
    // The host: lib/client — no Origin, no Sec-Fetch-*.
    post: (p, body, headers) => request(port, 'POST', p, body, { headers, timeout: 10000 }),
    get: (p, headers) => request(port, 'GET', p, null, { headers, timeout: 10000 }),
    publish: (event, sid, extra) => hooks.publish(env(event, sid, extra)),
    sessionStart: (sid) => h.publish('SessionStart', sid, { session: { source: 'startup' } }),
    // A turn the hooks alone open and close (no lock taken).
    tapTurn(sid, pid, text = `prompt ${pid}`) {
      h.publish('UserPromptSubmit', sid, { prompt_id: pid, prompt: { author: 'user', text } });
      h.publish('Stop', sid, { prompt_id: pid, stop: { last_assistant_message: 'ok' } });
    },
    begin: (sid, pid, text = `prompt ${pid}`) => h.post('/api/turn-begin', { message: text, author: 'user', ...session(sid, pid), prompt: { author: 'user', text } }),
    end: (sid, pid) => h.post('/api/turn-end', { ...session(sid, pid), last_assistant_message: 'ok', reply: 'ok' }),
    dirty: (k = 'k') => { state.store[k] = ++ts; },
    nodeFile: (id) => JSON.parse(fs.readFileSync(path.join(paths.GRAPH_DIR, `${id}.json`), 'utf8')),
    label: (id) => computeLabels(graph).get(id),
  };
  h.sessionStart(S1);
  h.sessionStart(S2);
  return h;
}

const liveIds = (h) => h.mirror.nodeTurns('live').turns.map((x) => x.id);

test('every commit path attaches: the locked turn-end (commit), the unlocked-turn commit (commit), /api/commit, set-active\'s preserve and stealStale\'s preserve (folded)', async (t) => {
  const h = await routesRig(t);

  // The locked turn-end: the host's Stop closes the turn on the tap, then commits.
  assert.equal((await h.begin(S1, 'p1')).status, 200);
  h.dirty();
  const ended = await h.end(S1, 'p1');
  assert.ok(ended.body.node_id, JSON.stringify(ended.body));
  const n1 = ended.body.node_id;
  assert.deepEqual(roleOf(h.nodeFile(n1)), { p1: 'commit' });
  assert.deepEqual(h.mirror.nodeTurns(n1).turns.map((x) => x.node), [{ id: n1, label: h.label(n1), role: 'commit' }]);

  // The unlocked-turn commit: a turn that began before the daemon ran (no lock).
  h.publish('UserPromptSubmit', S1, { prompt_id: 'p2', prompt: { author: 'user', text: 'no lock' } });
  h.dirty();
  const unlocked = await h.end(S1, 'p2');
  assert.equal(unlocked.body.unlocked, true);
  assert.deepEqual(roleOf(h.nodeFile(unlocked.body.node_id)), { p2: 'commit' });

  // /api/commit: no session, so the turn rides in folded.
  h.tapTurn(S2, 'q1');
  h.dirty();
  const manual = await h.post('/api/commit', { message: 'by hand' });
  assert.deepEqual(roleOf(h.nodeFile(manual.body.node_id)), { q1: 'folded' });

  // set-active's preserve: dirty work moves onto a preserve node first.
  h.tapTurn(S2, 'q2');
  h.dirty();
  const moved = await h.post('/api/graph/active', { id: n1 });
  assert.ok(moved.body.preserved, JSON.stringify(moved.body));
  assert.deepEqual(roleOf(h.nodeFile(moved.body.preserved)), { q2: 'folded' });
  assert.equal(h.mirror.nodeTurns(moved.body.preserved).turns[0].node.label, h.label(moved.body.preserved));

  // stealStale's preserve: a stale lock's abandoned work, taken by the next prompt.
  assert.equal((await h.begin(S1, 'p3')).status, 200);
  h.publish('Stop', S1, { prompt_id: 'p3', stop: { last_assistant_message: 'ok' } }); // its Stop never reached turn-end
  h.graph.lock.started_at = 0; // stale
  h.dirty();
  const stolen = await h.begin(S2, 'q3');
  assert.equal(stolen.status, 200);
  assert.ok(stolen.body.preserved, JSON.stringify(stolen.body));
  assert.deepEqual(roleOf(h.nodeFile(stolen.body.preserved)), { p3: 'folded' });
  assert.deepEqual(liveIds(h), [], 'q3 is open: nothing pending');
});

test('a no-change turn (skipTurn) and another session\'s Stop (foldOtherSession) stay pending and ride into the next commit folded', async (t) => {
  const h = await routesRig(t);
  await h.begin(S1, 'p1');
  const skipped = await h.end(S1, 'p1');
  assert.equal(skipped.body.skipped, 'no-change');
  assert.deepEqual(liveIds(h), ['p1']);

  await h.begin(S1, 'p2');
  h.publish('UserPromptSubmit', S2, { prompt_id: 'q1', prompt: { author: 'user', text: 'meanwhile' } });
  const folded = await h.end(S2, 'q1');
  assert.equal(folded.body.skipped, 'other-session');
  assert.deepEqual(liveIds(h).sort(), ['p1', 'q1']);

  h.dirty();
  const done = await h.end(S1, 'p2');
  const node = h.nodeFile(done.body.node_id);
  assert.deepEqual(roleOf(node), { p1: 'folded', p2: 'commit', q1: 'folded' });
  assert.equal(node.folded_count, 2, 'the graph\'s own folded entries, as before');
});

test('orphans through the routes: set-active with nothing dirty and new-graph orphan; a wipe keeps them pending; set-active with dirty work attaches them to the preserve', async (t) => {
  const h = await routesRig(t);
  h.dirty();
  const n0 = (await h.post('/api/commit', {})).body.node_id;
  h.dirty();
  const n1 = (await h.post('/api/commit', {})).body.node_id;

  h.tapTurn(S1, 'p1');
  await h.post('/api/graph/wipe', {});
  assert.deepEqual(liveIds(h), ['p1'], 'a wipe keeps them pending');
  h.state.store = { ...h.graph.nodes.get(n1).store };
  const clean = await h.post('/api/graph/active', { id: n0 });
  assert.equal(clean.body.preserved, null, JSON.stringify(clean.body));
  assert.deepEqual(liveIds(h), [], 'set-active with nothing dirty orphaned p1');

  h.tapTurn(S1, 'p2');
  await h.post('/api/graph/new', { name: 'fresh' });
  assert.deepEqual(liveIds(h), [], 'new-graph orphaned p2');

  h.tapTurn(S1, 'p3');
  h.dirty();
  const next = (await h.post('/api/commit', {})).body.node_id;
  assert.deepEqual(roleOf(h.nodeFile(next)), { p3: 'folded' }, 'the orphans are not taken');
  assert.equal(h.mirror.nodeTurns(next).turns.length, 1);

  h.tapTurn(S1, 'p4');
  h.dirty();
  const dirty = await h.post('/api/graph/active', { id: n0 });
  assert.ok(dirty.body.preserved);
  assert.deepEqual(roleOf(h.nodeFile(dirty.body.preserved)), { p4: 'folded' }, 'the preserve took p4 before the re-aim');
});

test('through a real facade: nodeTurns passes the read boundary (a planted key comes back masked) and attachToNode\'s answer holds no text', async (t) => {
  const h = await routesRig(t);
  const fakes = fakeSecrets({ seed: 44 }).filter((f) => f.id === 'sk-openrouter');
  assert.equal(fakes.length, 1);
  const secretPrompt = `deploy with ${fakes[0].text}`;
  await h.begin(S1, 'p1', secretPrompt);
  h.dirty();
  const id = (await h.end(S1, 'p1')).body.node_id;
  const node = h.nodeFile(id);
  assert.deepEqual(Object.keys(node.mirror).sort(), ['turns', 'v']);
  for (const ref of node.mirror.turns) {
    for (const k of Object.keys(ref)) assert.ok(REF_KEYS.includes(k), `a reference key: ${k}`);
    for (const v of Object.values(ref)) assert.ok(typeof v !== 'string' || !/\s/.test(v), 'ids only, no text');
  }
  assert.ok(!JSON.stringify(node.mirror).includes('deploy'), 'no prompt text in the node\'s link');
  const out = h.mirror.nodeTurns(id);
  assert.equal(out.turns.length, 1);
  assert.match(JSON.stringify(out), /deploy with/, 'the header carries the prompt preview');
  assert.deepEqual(findLeaks(out, fakes), [], 'masked on the way out');
  assert.deepEqual(findLeaks(h.mirror.nodeSummaries(), fakes), []);
});

test('GET /api/graph/node/:id keeps mirror locally and drops it for a remote viewer at basic', async (t) => {
  const h = await routesRig(t);
  await h.begin(S1, 'p1');
  h.dirty();
  const id = (await h.end(S1, 'p1')).body.node_id;
  const local = await h.get(`/api/graph/node/${id}`);
  assert.deepEqual(local.body.mirror, h.nodeFile(id).mirror);
  const remote = await h.get(`/api/graph/node/${id}`, { 'X-WC-Remote': '1' });
  assert.equal(remote.status, 200);
  assert.equal('mirror' in remote.body, false);
  const graphList = await h.get('/api/graph');
  assert.ok(!JSON.stringify(graphList.body).includes('"mirror"'), 'GET /api/graph lists topology, which never carries it');
});

// ── rig 3: the documents that draw a node ────────────────────────────────────

const MARK_TURN = 'glinkturnmark';

function markedNodeGraph(t) {
  const root = tmpRoot('wc-glink-docs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { paths, state, graph } = graphFor(root);
  const base = Date.now() - 5000;
  const pane = { id: 'a', html: '<p>pane-a-mark</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null };
  graph.registerNode({ ...nodeAt('n0', null, base), mounts: [pane] });
  graph.registerNode({
    ...nodeAt('n1', 'n0', base + 1000, { v: 1, turns: [{ conversation_id: S1, session_id: S1, turn_id: MARK_TURN, seq: 1, role: 'commit', from: 0, to: 9 }] }),
    mounts: [pane, { ...pane, id: 'b', html: '<p>pane-b-mark</p>' }],
  });
  graph.active = 'n1';
  return { root, paths, state, graph };
}

test('previewNodeJson of a node carrying mirror has no mirror key, and nothing of it', () => {
  const node = { id: 'n1', mounts: [], store: {}, mirror: { v: 1, turns: [{ turn_id: MARK_TURN }] } };
  const parsed = JSON.parse(previewNodeJson(node));
  assert.equal('mirror' in parsed, false);
  assert.ok(!previewNodeJson(node).includes(MARK_TURN));
  assert.equal(node.mirror.turns[0].turn_id, MARK_TURN, 'the node itself is untouched');
});

test('GET /preview/node/:id, the export and the replay of a node carrying mirror carry none of it', async (t) => {
  const { paths, state, graph, root } = markedNodeGraph(t);
  const ctx = { graph, paths, state, root, bus: createBus(), broadcastReset: () => {}, audience: createAudience({ configFile: null }) };
  const app = express();
  mountGraphRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => { server.closeAllConnections(); server.close(res); }));
  const preview = await request(server.address().port, 'GET', '/preview/node/n1', null, { timeout: 10000 });
  assert.equal(preview.status, 200);
  assert.equal(typeof preview.body, 'string');
  assert.ok(preview.body.includes('pane-b-mark'), 'the node\'s page is drawn');
  assert.ok(!preview.body.includes(MARK_TURN), 'and its turns are not');

  const resolved = nodeForExport(ctx, 'n1');
  for (const k of ['mounts', 'markdown', 'order', 'runs', 'store', 'nodeId', 'label']) assert.ok(k in resolved);
  assert.equal('mirror' in resolved, false);
  const built = buildExportHtml(ctx, 'n1', new Date('2026-10-06T12:00:00Z'));
  assert.ok(built.html.includes('pane-b-mark'), 'the export draws the page');
  assert.ok(!built.html.includes(MARK_TURN), 'the export carries no mirror');

  const res = resolveReplay(ctx, { from: 'n0', to: 'n1' });
  assert.equal(res.ok, true);
  for (const s of res.steps) assert.equal('mirror' in s.node, false, 'a replay step\'s node is only what the preview draws');
  const replay = buildReplay(ctx, { from: 'n0', to: 'n1' });
  assert.equal(replay.ok, true);
  assert.ok(replay.html.includes('pane-b-mark'), 'the replay draws the page');
  assert.ok(!replay.html.includes(MARK_TURN), 'no replay frame carries it');
});

// ── the graph-level stop ─────────────────────────────────────────────────────

test('stopGraph clears a held lock\'s stale timer and keeps it cleared', async (t) => {
  const root = tmpRoot('wc-glink-stop-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { graph } = graphFor(root);
  const bus = createBus();
  const timers = [];
  const hook = createHook({ init(_id, type, _trigger, resource) { if (type === 'Timeout') timers.push(resource); } }).enable();
  t.after(() => hook.disable());
  const r = turns.acquireLock(graph, bus, { message: 'hold', author: 'user', draftPath: graph.draftPath });
  assert.equal(r.ok, true);
  const ttl = turns.LOCK_TTL_MS;
  const staleTimer = () => timers.filter((tm) => !tm._destroyed && !tm.hasRef() && tm._idleTimeout > ttl - 60000 && tm._idleTimeout <= ttl + 1);
  assert.equal(staleTimer().length, 1, 'a held lock arms its stale timer');
  turns.stopGraph(graph);
  assert.equal(staleTimer().length, 0, 'the stop clears it');
  turns.releaseLock(graph, bus);
  turns.acquireLock(graph, bus, { message: 'again', author: 'user', draftPath: graph.draftPath });
  assert.equal(staleTimer().length, 0, 'a lock change after the stop arms nothing');
  turns.stopGraph(graph); // idempotent
  turns.stopGraph(null);
});

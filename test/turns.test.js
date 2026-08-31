const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const turns = require('../lib/server/domain/turns');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');

// A capturing bus: records every emit arg; returns a built-ish entry when there
// is an event (seq is a stand-in — these tests assert on the emit *arguments*,
// which is what byte-identity to the pre-Phase-3 routes depends on).
function fakeBus() {
  const emits = [];
  return { emits, emit: (arg) => { emits.push(arg); return arg && arg.event ? { seq: emits.length, ...arg.event } : null; } };
}

// A real graph over a throwaway dir (writeNode/saveMeta/computeLabels are real).
function tmpGraph(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-turns-'));
  const graphDir = path.join(dir, 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  if (t) t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const paths = { GRAPH_DIR: graphDir, META_PATH: path.join(graphDir, '_meta.json') };
  const state = createState();
  const graph = createGraph({ paths, state });
  return { graph, state, dir };
}

// ── SNAPSHOT_FIELDS / hydrateMount ─────────────────────────────────────────

test('hydrateMount picks exactly SNAPSHOT_FIELDS (extras dropped, omitted → present-but-undefined)', () => {
  const out = turns.hydrateMount({ html: '<p>x</p>', target: 'main', owner: 'claude', EXTRA: 'nope', id: 'ignored' });
  assert.deepEqual(Object.keys(out), turns.SNAPSHOT_FIELDS);
  assert.equal(out.html, '<p>x</p>');
  assert.equal(out.owner, 'claude');
  assert.equal('EXTRA' in out, false);
  assert.equal('id' in out, false);
  assert.ok('params' in out);
  assert.equal(out.params, undefined);
});

// ── Lock ───────────────────────────────────────────────────────────────────

test('lockIsStale: null → false, epoch → true, fresh → false', () => {
  assert.equal(turns.lockIsStale(null), false);
  assert.equal(turns.lockIsStale({ started_at: 0 }), true);
  assert.equal(turns.lockIsStale({ started_at: Date.now() }), false);
});

test('guardReaim: a fresh lock blocks — no saveMeta, no emit, lock untouched', (t) => {
  const { graph } = tmpGraph(t);
  graph.lock = { started_at: Date.now(), base: null };
  let saved = 0; const o = graph.saveMeta; graph.saveMeta = () => { saved++; o(); };
  const bus = fakeBus();
  const r = turns.guardReaim(graph, bus);
  assert.equal(r.blocked, true);
  assert.equal(r.lock, graph.lock);
  assert.equal(saved, 0);
  assert.equal(bus.emits.length, 0);
  assert.ok(graph.lock);
});

test('guardReaim: a stale lock is stolen WITH saveMeta + a seq-less lock:null frame (the drift fix)', (t) => {
  const { graph } = tmpGraph(t);
  graph.lock = { started_at: 0, base: null };
  let saved = 0; const o = graph.saveMeta; graph.saveMeta = () => { saved++; o(); };
  const bus = fakeBus();
  const r = turns.guardReaim(graph, bus);
  assert.equal(r.blocked, false);
  assert.equal(graph.lock, null);
  assert.equal(saved, 1, 'the steal is persisted — this is the new-graph drift fix');
  assert.deepEqual(bus.emits, [{ ws: { type: 'lock', lock: null } }]);
  assert.equal('event' in bus.emits[0], false, 'steal is WS-only, never a ring entry');
});

test('guardReaim: no lock → not blocked, no emit', (t) => {
  const { graph } = tmpGraph(t);
  const bus = fakeBus();
  const r = turns.guardReaim(graph, bus);
  assert.equal(r.blocked, false);
  assert.equal(bus.emits.length, 0);
});

test('acquireLock: sets the lock + emits a combined turn-begin event and lock WS frame', (t) => {
  const { graph } = tmpGraph(t);
  graph.active = 'n3';
  const bus = fakeBus();
  const r = turns.acquireLock(graph, bus, { message: 'hi', author: 'user' });
  assert.equal(r.ok, true);
  assert.equal(r.stole_stale_lock, false);
  assert.equal(graph.lock.base, 'n3');
  assert.equal(graph.lock.message, 'hi');
  assert.equal(bus.emits.length, 1);
  assert.deepEqual(bus.emits[0].event, { kind: 'graph', op: 'turn-begin', base: 'n3', stole_stale_lock: false });
  assert.deepEqual(bus.emits[0].ws, { type: 'lock', lock: graph.lock });
});

test('acquireLock: a fresh lock blocks (ok:false), no steal, no emit', (t) => {
  const { graph } = tmpGraph(t);
  graph.lock = { started_at: Date.now(), base: null };
  const held = graph.lock;
  const bus = fakeBus();
  const r = turns.acquireLock(graph, bus, {});
  assert.equal(r.ok, false);
  assert.equal(r.lock, held);
  assert.equal(graph.lock, held, 'lock untouched');
  assert.equal(bus.emits.length, 0);
});

test('acquireLock: steals a stale lock by overwrite (stole_stale_lock:true, one emit carrying the NEW lock)', (t) => {
  const { graph } = tmpGraph(t);
  graph.lock = { started_at: 0, base: 'old' };
  const bus = fakeBus();
  const r = turns.acquireLock(graph, bus, { message: 'm', author: 'user' });
  assert.equal(r.ok, true);
  assert.equal(r.stole_stale_lock, true);
  assert.equal(bus.emits.length, 1, 'no interim lock:null — a single overwrite emit');
  assert.equal(bus.emits[0].event.stole_stale_lock, true);
  assert.equal(bus.emits[0].ws.lock, graph.lock);
  assert.notEqual(graph.lock.base, 'old');
});

test('releaseLock: clears + always emits the unlock event; lock:null WS frame only when a lock was held', (t) => {
  const { graph } = tmpGraph(t);
  graph.lock = { started_at: Date.now(), base: null };
  const bus = fakeBus();
  const r = turns.releaseLock(graph, bus);
  assert.equal(r.cleared, true);
  assert.equal(graph.lock, null);
  assert.deepEqual(bus.emits[0].event, { kind: 'graph', op: 'unlock', had: true });
  assert.deepEqual(bus.emits[0].ws, { type: 'lock', lock: null });

  const bus2 = fakeBus();
  const r2 = turns.releaseLock(graph, bus2);
  assert.equal(r2.cleared, false);
  assert.deepEqual(bus2.emits[0].event, { kind: 'graph', op: 'unlock', had: false });
  assert.equal(bus2.emits[0].ws, null);
});

test('lockHeld counts ANY lock (even stale); clearLockOnBoot clears once, no-op without a lock', (t) => {
  const { graph } = tmpGraph(t);
  assert.equal(turns.lockHeld(graph), false);
  graph.lock = { started_at: 0, base: null }; // stale, but commit still 409s
  assert.equal(turns.lockHeld(graph), true);
  let saved = 0; const o = graph.saveMeta; graph.saveMeta = () => { saved++; o(); };
  turns.clearLockOnBoot(graph);
  assert.equal(graph.lock, null);
  assert.equal(saved, 1);
  turns.clearLockOnBoot(graph);
  assert.equal(saved, 1, 'no lock → no saveMeta');
});

// ── commitNode ─────────────────────────────────────────────────────────────

test('commitNode (turn-end params): node + node-added frame carry label + unlock; clears the lock', (t) => {
  const { graph, state } = tmpGraph(t);
  state.mounts.set('m1', { html: '<p>a</p>', target: 'main' });
  state.store.k = 1;
  graph.active = null;
  graph.lock = { base: null, started_at: Date.now(), message: 'do it' };
  const bus = fakeBus();
  const r = turns.commitNode(graph, bus, {
    draftPath: path.join(os.tmpdir(), 'nope-draft.json'), parentId: graph.lock.base, author: 'claude',
    triggerKind: 'turn', message: graph.lock.message, summary: undefined,
    clearLock: true, op: 'turn-end', includeLabelAndUnlock: true,
  });
  assert.equal(r.node_id, 'n0');
  assert.equal(graph.active, 'n0');
  assert.equal(graph.lock, null);
  const node = graph.nodes.get('n0');
  assert.equal(node.parent_id, null);
  assert.equal(node.trigger.kind, 'turn');
  assert.equal(node.trigger.summary, 'do it');
  // Mounts are snapshotted THROUGH hydrateMount, so the record carries exactly
  // id + SNAPSHOT_FIELDS — omitted fields present-but-undefined in memory, and
  // dropped on the way to disk by JSON.stringify (see graph-persistence.test.js).
  assert.deepEqual(Object.keys(node.mounts[0]), ['id', ...turns.SNAPSHOT_FIELDS]);
  assert.deepEqual(JSON.parse(JSON.stringify(node.mounts)), [{ id: 'm1', html: '<p>a</p>', target: 'main' }]);
  const e = bus.emits[0];
  assert.deepEqual(e.event, { kind: 'graph', op: 'turn-end', id: 'n0' });
  assert.equal(e.ws.type, 'node-added');
  assert.equal(e.ws.unlock, true);
  assert.equal(e.ws.node.label, 'n1.0');
  assert.deepEqual(Object.keys(e.ws.node), ['id', 'parent_id', 'created_at', 'author', 'trigger_summary', 'label']);
  assert.deepEqual(Object.keys(e.ws), ['type', 'node', 'active', 'unlock']);
});

test('commitNode (commit params): omits label + unlock, does not clear the lock, summary falls back to message', (t) => {
  const { graph, state } = tmpGraph(t);
  state.store.k = 1;
  graph.active = 'parent';
  graph.nextSeq = 5;
  const sentinelLock = { started_at: Date.now() };
  graph.lock = sentinelLock;
  const bus = fakeBus();
  const r = turns.commitNode(graph, bus, {
    draftPath: path.join(os.tmpdir(), 'nope-draft.json'), parentId: graph.active, author: 'manual',
    triggerKind: 'manual', message: 'msg', summary: undefined,
    clearLock: false, op: 'commit', includeLabelAndUnlock: false,
  });
  assert.equal(r.node_id, 'n5');
  assert.equal(graph.lock, sentinelLock, 'commit does not clear the lock');
  const e = bus.emits[0];
  assert.deepEqual(e.event, { kind: 'graph', op: 'commit', id: 'n5' });
  assert.equal('label' in e.ws.node, false);
  assert.equal('unlock' in e.ws, false);
  assert.equal(e.ws.node.trigger_summary, 'msg');
  assert.deepEqual(Object.keys(e.ws), ['type', 'node', 'active']);
});

// ── Draft round-trip ───────────────────────────────────────────────────────

test('writeDraft/loadDraft: empty-surface skip, round-trip via SNAPSHOT_FIELDS, base_active gate keeps the draft aside', (t) => {
  const { dir } = tmpGraph(t);
  const draftFile = path.join(dir, 'draft.json');

  assert.equal(turns.writeDraft(draftFile, 'n0', { mounts: [], store: {}, comments: [], captures: [] }), false);
  assert.equal(fs.existsSync(draftFile), false);

  const snap = { mounts: [{ id: 'm1', html: '<p>x</p>', target: 'main' }], store: { a: 1 }, comments: [], captures: [] };
  assert.equal(turns.writeDraft(draftFile, 'n0', snap), true);

  const s2 = createState();
  turns.loadDraft(draftFile, 'n0', s2);
  assert.equal(s2.store.a, 1);
  assert.deepEqual([...s2.mounts.keys()], ['m1']);
  assert.deepEqual(Object.keys(s2.mounts.get('m1')), turns.SNAPSHOT_FIELDS);

  turns.writeDraft(draftFile, 'n0', snap);
  const s3 = createState();
  turns.loadDraft(draftFile, 'DIFFERENT', s3);
  assert.equal(Object.keys(s3.store).length, 0);
  assert.equal(fs.existsSync(draftFile), false, 'a base_active-mismatched draft is not left at the live name');
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('draft.json.corrupt-'));
  assert.equal(aside.length, 1, 'it is renamed aside, never unlinked — a draft is the only copy of uncommitted work');
});

test('loadDraft: aside copies are capped, so a repeatedly-mismatched draft cannot pile up', (t) => {
  const { dir } = tmpGraph(t);
  const draftFile = path.join(dir, 'draft.json');
  const snap = { mounts: [{ id: 'm1', html: '<p>x</p>' }], store: {}, comments: [], captures: [] };
  for (let i = 0; i < 5; i++) {
    turns.writeDraft(draftFile, `n${i}`, snap);
    turns.loadDraft(draftFile, 'DIFFERENT', createState());
  }
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('draft.json.corrupt-'));
  // EXACTLY 3, not "at most 3": five mismatches produce five distinct names
  // (renameAside suffixes `-<i>` on a same-millisecond collision), so the cap
  // must leave the newest 3 standing. `<= 3` also passed a reaper that
  // over-reaped to 0/1/2 — and passed trivially on the old unlink-the-draft
  // behaviour, which left none at all. Those are the regressions this pins.
  assert.equal(aside.length, 3, `expected exactly 3 aside drafts, found ${aside.length}`);
});

// ── lock keep-alive ─────────────────────────────────────────────────────────
// A TTL is a wedge-breaker for a turn that never Stops, not a budget on how long
// a turn may take. Nothing re-stamped the clock during a turn, so a wake lock's
// deliberately short TTL was a hard window measured from the Push — and an
// agentic turn that outran it went stealable while it was still rendering.

test('installLockKeepalive: Claude\'s writes re-stamp a held lock', (t) => {
  const { graph } = tmpGraph(t);
  const bus = require('../lib/core/bus').createBus();
  turns.installLockKeepalive(graph, bus);

  const started = Date.now() - 5000;
  graph.lock = { base: null, started_at: started, author: 'wake', ttl_ms: 60_000 };
  bus.emit({ event: { kind: 'render', id: 'p', source: 'claude' } });
  assert.ok(graph.lock.started_at > started, 'the turn is demonstrably alive');
});

test('installLockKeepalive: a driver cannot hold a lock open, and a stale lock is not revived', (t) => {
  const { graph } = tmpGraph(t);
  const bus = require('../lib/core/bus').createBus();
  turns.installLockKeepalive(graph, bus);

  // A service-backed pane pushes continuously; if that kept the lock fresh, a
  // turn that ended long ago would wedge every user re-aim behind it.
  const started = Date.now() - 5000;
  graph.lock = { base: null, started_at: started, author: 'wake', ttl_ms: 60_000 };
  bus.emit({ event: { kind: 'render', id: 'p', source: 'service:git-dashboard' } });
  bus.emit({ event: { kind: 'store', patch: {}, source: 'server' } });
  bus.emit({ event: { kind: 'dom', source: 'browser' } });
  assert.equal(graph.lock.started_at, started, 'only the turn holder re-stamps');

  // Already stale: reviving it under a re-aim's feet is what the steal prevents.
  graph.lock = { base: null, started_at: 0, author: 'wake', ttl_ms: 60_000 };
  bus.emit({ event: { kind: 'render', id: 'p', source: 'claude' } });
  assert.equal(graph.lock.started_at, 0, 'a stale lock stays stealable');

  // No lock at all is simply not its business.
  graph.lock = null;
  bus.emit({ event: { kind: 'render', id: 'p', source: 'claude' } });
  assert.equal(graph.lock, null);
});

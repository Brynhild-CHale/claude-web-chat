// The mount-set engine (lib/server/domain/mounts) — the guards every route that
// puts a pane on the live surface now shares. Unit-level, because two of them
// (`gen`, and the exact ring event) are live-only server state with no HTTP
// projection: `gen` is deliberately absent from SNAPSHOT_FIELDS (decision D18),
// and /api/mounts reports identity, not the generation counter.

const test = require('node:test');
const assert = require('node:assert');
const { createBus } = require('../lib/core/bus');
const { setMount, removeMount, emitMount } = require('../lib/server/domain/mounts');

const freshState = () => ({ mounts: new Map(), store: {} });

test('mounts engine: a new pane is gen 0 and a same-id re-render bumps it', () => {
  const state = freshState();
  const bus = createBus();
  setMount(state, bus, { id: 'm1', html: '<p>a</p>' });
  assert.equal(state.mounts.get('m1').gen, 0);
  setMount(state, bus, { id: 'm1', html: '<p>b</p>' });
  assert.equal(state.mounts.get('m1').gen, 1, 'the queue Revert guard reads this');
});

test('mounts engine: component is written only when passed, never carried', () => {
  const state = freshState();
  const bus = createBus();
  setMount(state, bus, { id: 'm1', html: '<p>a</p>', component: 'git-dashboard' });
  assert.equal(state.mounts.get('m1').component, 'git-dashboard');
  // A plain render over a service-backed pane must DROP `component` — that is
  // how lib/server/services.js stops the child (`if (!m.component) continue`).
  setMount(state, bus, { id: 'm1', html: '<p>b</p>' });
  assert.equal(state.mounts.get('m1').component, undefined);
});

test('mounts engine: pane_state and form_state carry; params.form_reset drops form_state', () => {
  const state = freshState();
  const bus = createBus();
  setMount(state, bus, { id: 'm1', html: '<p>a</p>' });
  const m = state.mounts.get('m1');
  m.pane_state = { pinned: true };
  m.form_state = { '#name:0': 'typed' };
  setMount(state, bus, { id: 'm1', html: '<p>b</p>' });
  assert.deepEqual(state.mounts.get('m1').pane_state, { pinned: true });
  assert.deepEqual(state.mounts.get('m1').form_state, { '#name:0': 'typed' });
  setMount(state, bus, { id: 'm1', html: '<p>c</p>', params: { form_reset: true } });
  assert.equal(state.mounts.get('m1').form_state, undefined);
});

test('mounts engine: a locked pane soft-rejects before the owner gate is consulted', () => {
  const state = freshState();
  const bus = createBus();
  setMount(state, bus, { id: 'm1', html: '<p>a</p>' });
  state.mounts.get('m1').pane_state = { locked: true };
  const r = setMount(state, bus, { id: 'm1', html: '<p>b</p>', force: true });
  assert.equal(r.ok, false);
  assert.equal(r.locked, true, 'force takes over an OWNER, never a user lock');
  assert.equal(state.mounts.get('m1').html, '<p>a</p>');
});

test('mounts engine: the ring event names the writer and the byte count', () => {
  const state = freshState();
  const bus = createBus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  setMount(state, bus, { id: 'm1', html: '<p>a</p>', owner: 'service:git', component: 'git-dashboard' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'render');
  assert.equal(seen[0].source, 'service:git');
  assert.equal(seen[0].bytes, '<p>a</p>'.length);
  assert.equal(seen[0].component, 'git-dashboard');
});

// ── removeMount / emitMount ──────────────────────────────────────────────────

test('mounts engine: removeMount honours the generation guard and omits an absent target', () => {
  const state = freshState();
  const bus = createBus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  setMount(state, bus, { id: 'm1', html: '<p>a</p>' });          // gen 0
  setMount(state, bus, { id: 'm1', html: '<p>b</p>' });          // gen 1
  assert.equal(removeMount(state, bus, { id: 'm1', source: 'queue-revert', originGen: 0 }), false);
  assert.ok(state.mounts.has('m1'), 'a stale generation must not delete fresh content');
  assert.equal(removeMount(state, bus, { id: 'm1', source: 'queue-revert', originGen: 1 }), true);
  assert.equal(state.mounts.has('m1'), false);
  const clear = seen.filter((e) => e.kind === 'clear');
  assert.equal(clear.length, 1, 'the rejected revert emitted nothing');
  assert.ok(!('target' in clear[0]), 'target is omitted when the caller did not supply one');
});

test('mounts engine: removeMount of an unknown id is a no-op, not a frame', () => {
  const state = freshState();
  const bus = createBus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  assert.equal(removeMount(state, bus, { id: 'nope', source: 'claude', target: 'main' }), false);
  assert.equal(seen.length, 0);
});

test('mounts engine: emitMount re-broadcasts the pane as it stands without touching it', () => {
  const state = freshState();
  const bus = createBus();
  setMount(state, bus, { id: 'm1', html: '<p>a</p>', component: 'git-dashboard' });
  const before = state.mounts.get('m1');
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  assert.equal(emitMount(state, bus, 'm1', { source: 'queue-revert' }), true);
  assert.equal(state.mounts.get('m1'), before, 'the record is untouched — no gen bump, no replacement');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'render');
  assert.equal(seen[0].source, 'queue-revert');
  assert.equal(emitMount(state, bus, 'gone'), false);
});

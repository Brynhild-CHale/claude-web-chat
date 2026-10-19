// The v3→v4 planner's output, frozen (U248). planMigration got faster
// (park rule b2 read once per copy, its hashes memoised per plan); what it plans
// must not move by a byte. The digest is test-support/v3-scale-fakes planDigest's
// (stableHash of {rest, actions, pins, draft, states}); both literals were
// computed on the planner as U204 and U247a left it (ae/int 8a889f8), before the
// speed change. The counters and the park object stand beside them as readable
// deepEquals, so a drift says which part moved.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { v3Graph } = require('../test-support/v3-graph');
const { planDigest } = require('../test-support/v3-scale-fakes');

function fixture(t, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-v3-frozen-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return v3Graph(root, opts);
}

test('the fixed v3 graph plans exactly as at 8a889f8', (t) => {
  const g = fixture(t);
  const { digest, plan } = planDigest(g.stateDir);
  assert.deepStrictEqual(plan.counters, {
    reused_on_edge: 14, reused_by_hash: 0, reused_homeless: 0, reused_logged: 0,
    minted_root: 7, minted_edge: 7, beside_only_mints: 0, reuse_refused_home_off_ancestry: 1,
    elements_new: 6, versions_new: 14, commits_new: 6, commits_present: 0,
  });
  assert.deepStrictEqual(plan.park, {
    rule: 'b2', kept_copies: 22, parked_copies: 1, orphans_total: 2, median_orphans_per_node: 0, max_orphans_per_node: 1,
    pin_carrying_nodes: 6, homeless_pin_ids: 0, homeless_ids: [], replies_lost: 0,
    states: { present: 20, orphan: 2, parked: 1 },
  });
  // The ghost case's four copies of c4 keep their verdicts (v3-graph's `ghosts`).
  assert.deepStrictEqual(['n1', 'n2', 'n3', 'n4'].map((n) => plan.detail.states.get(`${n}|c4`)), ['present', 'orphan', 'parked', 'orphan']);
  assert.strictEqual(plan.copies, 23);
  assert.strictEqual(plan.actions.filter((a) => a.op === 'ver').length, 14);
  assert.strictEqual(plan.seq_floor, 42);
  assert.deepStrictEqual(plan.refused_reuse, [{ id: 'c5', node: 'n5', v: 3 }]);
  assert.strictEqual(digest, '906eeb1c7aa3280e1d0724683879c0e8b0b47e78');
});

test('the scaled v3 graph (300 nodes x 14, seed 7) plans exactly as at 8a889f8', (t) => {
  const g = fixture(t, { scale: { nodes: 300, copies: 14, seed: 7 } });
  const { digest, plan } = planDigest(g.stateDir);
  assert.deepStrictEqual(plan.counters, {
    reused_on_edge: 3783, reused_by_hash: 0, reused_homeless: 0, reused_logged: 0,
    minted_root: 14, minted_edge: 405, beside_only_mints: 0, reuse_refused_home_off_ancestry: 0,
    elements_new: 14, versions_new: 419, commits_new: 300, commits_present: 0,
  });
  assert.deepStrictEqual(plan.park, {
    rule: 'b2', kept_copies: 4148, parked_copies: 52, orphans_total: 375, median_orphans_per_node: 0, max_orphans_per_node: 11,
    pin_carrying_nodes: 300, homeless_pin_ids: 0, homeless_ids: [], replies_lost: 0,
    states: { present: 3773, orphan: 375, parked: 52 },
  });
  assert.strictEqual(plan.copies, 4200);
  assert.strictEqual(plan.actions.filter((a) => a.op === 'ver').length, 419);
  assert.strictEqual(digest, '81eba533a51806f9561b0ecb3e2b474312d09a6f');
});

'use strict';
// The boot reconcile of the element log against the graph (PLAN 1A.3; GT-10).
//
// createServer calls it once per boot, after graph.load and clearLockOnBoot and
// before the active node is restored: reconcileElements({graph, store, bus,
// paths, migration}). It answers a report and hands it to the store
// (store.setIntegrity), where the health route reads it.
//
// THIS IS THE CALL SITE'S STUB (U203). The states — clean, adopting a node
// without a commit record, rolling forward, an orphaned or dangling commit
// record, a copy whose v does not hold its payload, the draft, a torn tail, a
// refused migration — the boot report on disk, the host-only health field and
// the `integrity` bus event are U209's, which replaces this module whole.

function reconcileElements({ store } = {}) {
  const report = { clean: true, stub: true, states: {} };
  if (store && typeof store.setIntegrity === 'function') store.setIntegrity(report);
  return report;
}

module.exports = { reconcileElements };

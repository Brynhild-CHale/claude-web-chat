'use strict';

// The one anchor-state vocabulary (annotation engine, PLAN.md 1C.5), shared by
// the three anchor families (element, range, source) and everything that reads
// an answer: the resolver (lib/core/anchors.js, which takes it injected as
// STATES and never spells a state it did not take from here), the overlay, the
// log's retention table. Order is the plan's and is part of the contract.
//
// Zero imports: lib/core/anchors.js inlines it into the browser module and the
// document source as JSON.

const ANCHOR_STATES = Object.freeze([
  'exact',
  're-resolved',
  'orphaned',
  'hidden',
  'masked',
  'provisional',
  'superseded',
  'expired',
  'draw-failed',
]);

function isAnchorState(s) {
  return typeof s === 'string' && ANCHOR_STATES.indexOf(s) !== -1;
}

module.exports = { ANCHOR_STATES, isAnchorState };

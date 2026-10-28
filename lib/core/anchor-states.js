'use strict';

// The one anchor-state vocabulary (annotation engine, PLAN.md 1C.5), shared by
// the three anchor families (element, range, source) and everything that reads
// an answer: the resolver (lib/core/anchors.js, which takes it injected as
// STATES and never spells a state it did not take from here), the overlay, the
// log's retention table. Order is the plan's and is part of the contract.
//
// Tranche 3 (PLAN.md 3A.1, U414) APPENDS 'indexing' and 'unavailable', the chat
// anchors' (lib/server/mirror/chat-anchors.js): appended, so every reader of a
// leading slice (element-log.js ANSWER_STATES, reports.js REPORT_STATES) and
// every lookup by name (codediff's EXPIRED) is unchanged.
//
// Zero imports: lib/core/anchors.js inlines ANCHOR_STATES into the browser
// module and the document source as JSON (VISIBLE and EXPLAIN are not inlined:
// the chrome reads them from the daemon's answers).

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
  'indexing',
  'unavailable',
]);

// A chat pin always shows one of six visible states (DECISIONS.md L.2 L4):
// each chat-anchor state → the one the user sees. `expired` (a web-chat count
// cap) is retired — nothing produces it after tranche 3 — and reads as
// unavailable. 'orphaned', 'hidden' and 'draw-failed' are the page's: a chat
// anchor is never orphaned (a quote no longer found is unavailable).
const VISIBLE = Object.freeze({
  exact: 'placed',
  're-resolved': 'placed',
  provisional: 'refused',
  superseded: 'superseded',
  masked: 'masked',
  indexing: 'indexing',
  unavailable: 'unavailable',
  expired: 'unavailable',
});

// The one line each visible state shows (RULED 2026-10-28 Q6 = a, as written):
// the chrome, Claude's tools and the docs' when-table all read this table, and
// nothing rewords a line anywhere else. A kind's own line (an answer's `note`,
// such as a pending diff's) is shown instead of it when present.
const EXPLAIN = Object.freeze({
  placed: 'Pinned here.',
  refused: 'This reply is still arriving — pin it once the transcript has it.',
  superseded: 'This turn was rewound in the terminal; the pin stays on the turn it was made on.',
  masked: 'The pinned words now hold a value web-chat hides; the pin covers the hidden part and never shows it.',
  indexing: 'This conversation is being read; the pin places when that is done.',
  unavailable: 'What this pin was on is no longer on this machine; its quote is kept.',
});

function isAnchorState(s) {
  return typeof s === 'string' && ANCHOR_STATES.indexOf(s) !== -1;
}

module.exports = { ANCHOR_STATES, VISIBLE, EXPLAIN, isAnchorState };

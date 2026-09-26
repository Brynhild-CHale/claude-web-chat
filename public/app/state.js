// Shared view/preview state — one mutable singleton, mutated in place so every
// module sees the same values (the old client kept these as file-global `let`s
// declared before the store; in ESM a shared object avoids TDZ/circular-import
// hazards — see rewrite risk #5).
//
//   activeId       the committed active node (server-authoritative)
//   viewedId       the node being viewed (null = viewing live/active)
//   lock           the turn lock, or null (server-authoritative, read-only here)
//   conn           the socket: 'connecting' | 'live' | 'reconnecting' (ws.js
//                  writes it; the topbar's one status pill reads it)
//   previewing     true while a detached node preview is up — GATES all writes
//                  (store echo, pane:state, events) so a preview never mutates
//                  the live node (risk #3)
//   liveSnapshot   folded live surface captured while previewing
//   graphCache     last /api/graph payload
//   expandedStacks ×N stacks expanded into sleeves on the graph screen (by run head)
//   selectedNodeId the node selected on the graph screen (null = none, no inspector)
export const view = {
  activeId: null,
  viewedId: null,
  lock: null,
  conn: 'connecting',
  previewing: false,
  liveSnapshot: null,
  graphCache: null,
  expandedStacks: new Set(),
  selectedNodeId: null,
};

// DOM by id — one short helper, used everywhere.
export const $ = (id) => document.getElementById(id);

// A mount host by MOUNT id — the other half of the lookup pair, and the only
// way anything should turn an agent-supplied mount id into an element. A mount
// id is arbitrary text ('main', 'status', 'drawer' are all plausible ids for
// Claude to pick), so `$` would happily hand back a chrome element instead: the
// host therefore always carries its id in `dataset.mountId` and only mirrors it
// onto the DOM id when that id is free (see mount() in mounts.js). Both
// consumers — the mount lifecycle and the comment-pin anchors — resolve through
// here so the two halves cannot drift.
//
// It scans rather than selects because an arbitrary id would have to be
// CSS-escaped to go into a selector.
export function hostFor(id) {
  if (id == null) return null;
  for (const h of document.querySelectorAll('.mount-host')) {
    if ((h.dataset.mountId || h.id) === id) return h;
  }
  return null;
}

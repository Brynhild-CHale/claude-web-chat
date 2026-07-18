// Shared view/preview state — one mutable singleton, mutated in place so every
// module sees the same values (the old client kept these as file-global `let`s
// declared before the store; in ESM a shared object avoids TDZ/circular-import
// hazards — see rewrite risk #5).
//
//   activeId       the committed active node (server-authoritative)
//   viewedId       the node being viewed (null = viewing live/active)
//   lock           the turn lock, or null (server-authoritative, read-only here)
//   previewing     true while a detached node preview is up — GATES all writes
//                  (store echo, pane:state, events) so a preview never mutates
//                  the live node (risk #3)
//   liveSnapshot   folded live surface captured while previewing
//   graphCache     last /api/graph payload
//   expandedStacks stacks expanded in the graph DAG
//   selectedNodeId currently selected node in the graph overlay
export const view = {
  activeId: null,
  viewedId: null,
  lock: null,
  previewing: false,
  liveSnapshot: null,
  graphCache: null,
  expandedStacks: new Set(),
  selectedNodeId: null,
  // node id a branch-on-edit re-aim is in flight for (set before the POST,
  // cleared after). Lets the ws 'branch-here' handler distinguish the editing
  // client (local transition, DOM must not be re-rendered) from bystanders.
  branchingTo: null,
};

// DOM by id — one short helper, used everywhere.
export const $ = (id) => document.getElementById(id);

// Read a resolved --wc-* token off :root (SVG needs literal values, not var()).
export const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

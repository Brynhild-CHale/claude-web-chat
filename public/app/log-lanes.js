// The phone log's fork gutter, computed — never drawn by hand.
//
// Input: the graph's DRAWN nodes (graph-view's display topology), newest first,
// each with its drawn parent. Output: for every row, which lane its dot sits in
// and which line segments pass through that row, git-log style:
//
//   * a lane is a column that is "waiting for" a node further down the log —
//     the parent of something already drawn above;
//   * a row's node takes the lane that was waiting for it (the first one, when a
//     fork left several children waiting for the same parent), or the first free
//     lane when nothing was (a branch tip);
//   * every OTHER lane waiting for this node closes here: a curve from its column
//     at the top of the row into this node's dot (`merges`) — that curve is the
//     fork, read upward;
//   * every lane waiting for something else runs straight through.
//
// A child is always newer than its parent, so newest-first puts every child
// above its parent and one pass suffices. Rows are 0..100 tall in the unit the
// gutter SVG stretches (preserveAspectRatio="none"); the dot sits at 50.
//
// Pure, and a leaf (no imports, no DOM), so the lane arithmetic is testable on
// its own and nothing about the gutter depends on the page it is drawn in.
export function computeLogLanes(rows) {
  const ids = new Set(rows.map((r) => r.id));
  let lanes = [];              // lane index -> the node id it is waiting for, or null
  let width = 0;
  const out = [];
  for (const r of rows) {
    const parent = r.parent != null && ids.has(r.parent) ? r.parent : null;
    const before = lanes.slice();
    let col = before.indexOf(r.id);
    const entered = col !== -1;          // a line comes down into this dot
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) { col = lanes.length; lanes.push(null); }
    }
    const merges = [];
    const lines = [];
    before.forEach((waiting, k) => {
      if (waiting == null) return;
      if (waiting === r.id) {
        if (k !== col) { merges.push({ from: k, to: col }); lanes[k] = null; }
      } else {
        lines.push({ lane: k, y1: 0, y2: 100 });
      }
    });
    if (entered) lines.push({ lane: col, y1: 0, y2: 50 });
    lanes[col] = parent;
    if (parent != null) lines.push({ lane: col, y1: 50, y2: 100 });
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    width = Math.max(width, before.length, col + 1);
    // the lanes still open BELOW this row — what a ghost row under it continues
    const below = [];
    lanes.forEach((waiting, k) => { if (waiting != null) below.push(k); });
    out.push({ id: r.id, col, lines, merges, below });
  }
  return { rows: out, lanes: Math.max(1, width) };
}

// Gutter geometry, in px (the gutter SVG's viewBox is px-wide): the design's
// 14px first lane and 16px pitch, and a gutter never narrower than its 40px.
export const LANE_X0 = 14;
export const LANE_PITCH = 16;
export const laneX = (lane) => LANE_X0 + LANE_PITCH * lane;
export const gutterWidth = (lanes) => Math.max(40, LANE_X0 * 2 + LANE_PITCH * (lanes - 1));

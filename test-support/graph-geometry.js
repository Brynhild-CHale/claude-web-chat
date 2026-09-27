// Geometry of the graph canvas as DRAWN, for the chrome tests that check what an
// edge passes through. jsdom lays out nothing (no getBBox, no getTotalLength),
// so this reads the SVG attributes the renderer wrote: it samples each edge's
// `d` (M / L / Q / C, absolute — all graph-view.js emits) into points, estimates
// each text's box from its anchor, baseline and length, and finds where an edge
// strikes a node body, a text box or a tree heading, and where two elbows share
// a sideways run.

const CHAR_W = 6.6;          // an 11px mono advance; the canvas text is 9.5–11px
const num = (el, a) => Number(el.getAttribute(a));

// The path as segments: { kind: 'L'|'Q'|'C', pts: [p0, …controls, p1] }.
function segments(d) {
  const tok = d.match(/[MLQC]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g);
  const segs = [];
  let i = 0, cur = null, cmd = null;
  const pt = () => ({ x: Number(tok[i++]), y: Number(tok[i++]) });
  while (i < tok.length) {
    if (/[MLQC]/.test(tok[i])) cmd = tok[i++];
    if (cmd === 'M') { cur = pt(); cmd = 'L'; continue; }
    if (cmd === 'L') { const p = pt(); segs.push({ kind: 'L', pts: [cur, p] }); cur = p; }
    else if (cmd === 'Q') { const c = pt(), p = pt(); segs.push({ kind: 'Q', pts: [cur, c, p] }); cur = p; }
    else if (cmd === 'C') { const c1 = pt(), c2 = pt(), p = pt(); segs.push({ kind: 'C', pts: [cur, c1, c2, p] }); cur = p; }
    else throw new Error('unexpected path token ' + tok[i]);
  }
  return segs;
}

function at(seg, t) {
  const [p0, p1, p2, p3] = seg.pts, u = 1 - t;
  if (seg.kind === 'L') return { x: u * p0.x + t * p1.x, y: u * p0.y + t * p1.y };
  if (seg.kind === 'Q') return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

// Points along the path, about one per pixel.
function samples(d) {
  const out = [];
  for (const s of segments(d)) {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) + 8));
    for (let k = 0; k <= n; k++) out.push(at(s, k / n));
  }
  return out;
}

// The straight sideways stretches of a path.
function runs(d) {
  return segments(d).filter((s) => s.kind === 'L' && s.pts[0].y === s.pts[1].y && s.pts[0].x !== s.pts[1].x)
    .map((s) => ({ y: s.pts[0].y, x0: Math.min(s.pts[0].x, s.pts[1].x), x1: Math.max(s.pts[0].x, s.pts[1].x) }));
}

// A <text>'s box: cap height ~10px above the baseline, descenders ~4px below.
function textBox(t) {
  const w = t.textContent.length * CHAR_W, x = num(t, 'x'), base = num(t, 'y');
  const x0 = t.getAttribute('text-anchor') === 'middle' ? x - w / 2 : x;
  return { x0, x1: x0 + w, y0: base - 10, y1: base + 4, what: `"${t.textContent}"` };
}

// Everything on the canvas an edge must not cross: node bodies (as circles),
// the text around the glyphs, the tree headings.
function obstacles(doc) {
  const svg = doc.getElementById('graph-svg');
  const bodies = [...svg.querySelectorAll('.gv-body')].map((c) => ({ cx: num(c, 'cx'), cy: num(c, 'cy'), r: num(c, 'r') }));
  const boxes = [...svg.querySelectorAll('.gv-lbl, .gv-bm, .gv-card-range, .gv-fold-n')].map(textBox);
  for (const r of svg.querySelectorAll('.gv-tt-hit')) {
    boxes.push({ x0: num(r, 'x'), x1: num(r, 'x') + num(r, 'width'), y0: num(r, 'y'), y1: num(r, 'y') + num(r, 'height'), what: 'a tree heading' });
  }
  return { bodies, boxes };
}

// Every place an edge passes through something, as readable strings. A node's
// own edges touch its rim (a fork leaves from it, an edge ends on it), so a body
// counts as struck only a pixel inside the rim.
function strikes(doc) {
  const { bodies, boxes } = obstacles(doc);
  const out = [];
  for (const e of doc.querySelectorAll('#graph-svg .gv-edge')) {
    const d = e.getAttribute('d');
    const hit = new Set();
    for (const p of samples(d)) {
      for (const b of bodies) if (Math.hypot(p.x - b.cx, p.y - b.cy) < b.r - 1) hit.add(`the node at (${b.cx},${b.cy})`);
      for (const b of boxes) if (p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1) hit.add(b.what);
    }
    for (const h of hit) out.push(`${d} strikes ${h}`);
  }
  return out;
}

// Pairs of edges running sideways along each other (closer than `gap`).
function sharedRuns(doc, gap = 3) {
  const all = [...doc.querySelectorAll('#graph-svg .gv-edge')].map((e) => ({ d: e.getAttribute('d'), runs: runs(e.getAttribute('d')) }));
  const out = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    for (const r of all[i].runs) for (const s of all[j].runs) {
      if (Math.abs(r.y - s.y) < gap && Math.min(r.x1, s.x1) - Math.max(r.x0, s.x0) > 1) out.push(`${all[i].d}  ‖  ${all[j].d}`);
    }
  }
  return out;
}

module.exports = { segments, samples, runs, textBox, strikes, sharedRuns };

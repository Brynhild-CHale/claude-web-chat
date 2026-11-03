// The suite's fixture strokes type (U565): no import, fetch or eval.
const NS = 'http://www.w3.org/2000/svg';
const at = (e, o) => { for (const k in o) e.setAttribute(k, o[k]); return e; };
let h = null;

export default function draw(group, ctx) {
  const c = group.container;
  const d = c.ownerDocument;
  const svg = at(d.createElementNS(NS, 'svg'), { viewBox: '0 0 1 1', preserveAspectRatio: 'none', width: '100%', height: '100%' });
  if (group.kind === 'guess') svg.setAttribute('opacity', '0.4');
  const w = ctx.box ? ctx.box.w : 0;
  for (const it of group.items) {
    const r = ctx.record ? ctx.record(it.id) : null;
    const p = r && (r.payload || r);
    if (!p || !Array.isArray(p.points)) continue;
    let line = '';
    for (let i = 0; i + 1 < p.points.length; i += p.stride || 4) line += (i ? ' L' : 'M') + p.points[i] + ' ' + p.points[i + 1];
    const path = at(d.createElementNS(NS, 'path'), {
      d: line, fill: 'none', stroke: 'currentColor', 'vector-effect': 'non-scaling-stroke',
      'stroke-width': String(w > 0 && p.width > 0 ? p.width * w : 1), 'data-el-id': it.id,
    });
    if (/^[a-z-]+$/.test(p.colour)) path.style.color = `var(--wc-${p.colour})`;
    svg.appendChild(path);
  }
  c.replaceChildren(svg);
}

function paint(g, view) {
  view.clear();
  g.beginPath();
  for (let i = 0; i < view.count; i++) g.lineTo(view.x(i), view.y(i));
  g.stroke();
}

export function create(input, ctx) {
  const wet = ctx.wet, ph = input.phase, up = ph === 'pointerup';
  if (ph === 'pointerdown') {
    h = ctx.stroke.begin(input);
    if (h && wet) wet.begin(h.frame.target, { pointerId: input.event.pointerId });
  } else if (h && ph === 'pointermove') {
    h.push(input.samples);
    if (wet) { wet.push(input.samples, { predicted: input.predicted }); wet.paint(paint); }
  } else if (h && (up || ph === 'pointercancel')) {
    if (up) h.commit({ tool: 'pen', width: 2, colour: 'accent', shared: false }); else h.cancel();
    h = null;
    if (wet) wet[up ? 'end' : 'cancel']();
  }
}

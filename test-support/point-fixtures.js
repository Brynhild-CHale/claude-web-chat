// Fixed-aspect panes for the point anchor (annotation engine, PLAN.md 4C.1;
// DECISIONS.md C5; U533): the environment harness's fixture set
// (test/point-environment.test.js) and the one the F3 gate adapter may import
// for points.js --built's img and canvas groups.
//
// SYNTHETIC, every byte: never copied from the design corpus, a real project,
// any ~/.web-chat or ~/.claude (the corpus holds real panes). The prose is
// invented filler; the images are drawn here with lib/core/png encodePng (the
// one encoder) and carried as data: URIs; nothing names any other URL (the svg
// namespace a script hands createElementNS is a name, never fetched).
//
// A point sits only on a fixed-aspect target (C5): an svg, an img, a canvas or
// an element marked data-fixed-aspect. So every pane here holds ONE such target
// beside prose that reflows around it (a float), and the target scales with
// its box (CSS width 100%, height auto) so a narrower page keeps its aspect:
//
//   three svg  — one static with a viewBox; two built by the pane's script with
//                createElementNS, as the corpus's svg are (one with transformed
//                groups and a nested svg, which a point resolves to the
//                OUTERMOST svg);
//   two img    — PNGs with distinct coloured regions at known pixel boxes;
//   two canvas — fixed width/height attributes, shapes drawn by the pane's
//                script at known canvas coordinates.
//
// THE SHAPE (plain data, frozen):
//   { id, type: 'svg'|'img'|'canvas', title, html, target, features, png? }
//   target    a selector inside the pane matching the one fixed-aspect element;
//   features  [{ name, shape }]  an svg shape's selector: its own box is the
//                                feature (the svg fixtures);
//             [{ name, box }]    {x, y, w, h} in the target's normalised 0..1
//                                space, × the target's box (img and canvas);
//   png       {width, height} the img fixture's declared image size (its
//             data: URI decodes to it).
//
// fixtureNode({fixtures, id, anchor}) → the panes as the mounts of ONE node
// carrying one comment copy whose anchor is a point, so the preview's
// carriesElements (lib/server/runtime/anchors-src) splices the point cut: the
// real splice, the same document a node preview serves. The default anchor is
// only the splice's trigger (kind 'point' on the first pane); a caller that
// recorded a real one passes it.

const { encodePng } = require('../lib/core/png');

const TARGET_TYPES = Object.freeze(['svg', 'img', 'canvas']);
const SVG_NS = 'http://www.w3.org/2000/svg';

// An RGBA PNG of `width` × `height`: the background, then each region's
// [x, y, w, h] pixel box filled with its [r, g, b].
function paintPng(width, height, background, regions) {
  const rgba = Buffer.alloc(width * height * 4);
  const fill = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * width + x) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
      }
    }
  };
  fill(0, 0, width, height, background);
  for (const reg of regions) fill(...reg.px, reg.rgb);
  return encodePng(rgba, width, height);
}
const dataUri = (png) => `data:image/png;base64,${png.toString('base64')}`;

// A pixel (or canvas-unit) box [x, y, w, h] in the target's normalised space.
const norm = ([x, y, w, h], width, height) => ({ x: x / width, y: y / height, w: w / width, h: h / height });

// The pane around a target: a floated figure beside prose, so the text reflows
// around it as the page narrows while the target keeps its aspect.
const STYLE = '<style>'
  + '.wrap{font:14px/1.55 system-ui,sans-serif;color:#222}'
  + '.wrap::after{content:"";display:block;clear:both}'
  + '.fig{float:left;width:46%;margin:0 16px 8px 0}'
  + '.fig.right{float:right;margin:0 0 8px 16px;width:34%}'
  + '.fig svg,.fig img,.fig canvas{display:block;width:100%;height:auto}'
  + '.fig figcaption{font-size:12px;color:#666;margin-top:4px}'
  + 'p{margin:0 0 10px}'
  + '</style>';
const PROSE = [
  'The figure beside this text is drawn at a fixed aspect, so a point placed on it keeps its place as the page narrows.',
  'These sentences are filler that wraps around the figure; at a narrow width they run below it, and the figure shrinks with its column.',
  'Nothing here reads the clock, the locale or the layout, so every environment draws the same words.',
];
function pane({ cls = '', fig, caption, script = '' }) {
  return STYLE
    + `<div class="wrap"><figure class="fig${cls ? ` ${cls}` : ''}">${fig}<figcaption>${caption}</figcaption></figure>`
    + PROSE.map((p) => `<p>${p}</p>`).join('')
    + '</div>'
    + (script ? `<script>${script}</script>` : '');
}

// ── svg ─────────────────────────────────────────────────────────────────────

const SVG_STATIC = pane({
  caption: 'Three marks on a static chart',
  fig: '<svg class="chart" viewBox="0 0 400 240" width="400" height="240" role="img" aria-label="Three marks">'
    + '<rect class="bg" x="0" y="0" width="400" height="240" fill="#f4f1ea"></rect>'
    + '<rect class="bar-a" x="40" y="110" width="80" height="110" fill="#c0603a"></rect>'
    + '<rect class="bar-b" x="160" y="40" width="80" height="180" fill="#3a6fc0"></rect>'
    + '<circle class="dot" cx="320" cy="90" r="34" fill="#4c9a52"></circle>'
    + '<text class="label" x="200" y="234" text-anchor="middle" font-size="12">static</text>'
    + '</svg>',
});

// Built by the pane's script with createElementNS (the corpus's way).
const SVG_BARS = pane({
  caption: 'Bars built by script',
  fig: '<div class="chart-host"></div>',
  script: [
    `var NS = '${SVG_NS}';`,
    'var svg = document.createElementNS(NS, "svg");',
    'svg.setAttribute("class", "bars"); svg.setAttribute("viewBox", "0 0 300 200");',
    'svg.setAttribute("width", "300"); svg.setAttribute("height", "200");',
    'var bg = document.createElementNS(NS, "rect");',
    'bg.setAttribute("width", "300"); bg.setAttribute("height", "200"); bg.setAttribute("fill", "#f7f7f2"); svg.appendChild(bg);',
    'var DATA = [[20, 70, "#b5523b"], [85, 120, "#3b6fb5"], [150, 45, "#5b9a4c"], [215, 150, "#8a4cb5"]];',
    'DATA.forEach(function (d, i) {',
    '  var r = document.createElementNS(NS, "rect");',
    '  r.setAttribute("class", "bar bar-" + i);',
    '  r.setAttribute("x", d[0]); r.setAttribute("y", 185 - d[1]);',
    '  r.setAttribute("width", 50); r.setAttribute("height", d[1]); r.setAttribute("fill", d[2]);',
    '  svg.appendChild(r);',
    '});',
    'root.querySelector(".chart-host").appendChild(svg);',
  ].join('\n'),
});

// Built by script, with translated groups and a nested svg: a point on a shape
// inside the nested svg still anchors to the OUTERMOST svg.
const SVG_SCATTER = pane({
  cls: 'right',
  caption: 'A scatter with an inset',
  fig: '<div class="plot-host"></div>',
  script: [
    `var NS = '${SVG_NS}';`,
    'function el(tag, attrs, parent) {',
    '  var n = document.createElementNS(NS, tag);',
    '  for (var k in attrs) n.setAttribute(k, attrs[k]);',
    '  parent.appendChild(n); return n;',
    '}',
    'var svg = el("svg", { "class": "scatter", viewBox: "0 0 360 240", width: "360", height: "240" }, root.querySelector(".plot-host"));',
    'el("rect", { width: 360, height: 240, fill: "#f2f4f7" }, svg);',
    'var g1 = el("g", { "class": "series-a", transform: "translate(30,20)" }, svg);',
    'el("circle", { "class": "pt-a", cx: 40, cy: 50, r: 18, fill: "#c0603a" }, g1);',
    'el("circle", { "class": "pt-b", cx: 120, cy: 150, r: 22, fill: "#c0603a" }, g1);',
    'var g2 = el("g", { "class": "series-b", transform: "translate(170,30) scale(1.5)" }, svg);',
    'el("rect", { "class": "pt-c", x: 10, y: 60, width: 30, height: 24, fill: "#3a6fc0" }, g2);',
    'var inset = el("svg", { "class": "inset", x: 250, y: 140, width: 90, height: 80, viewBox: "0 0 90 80" }, svg);',
    'el("rect", { width: 90, height: 80, fill: "#e5e9ef" }, inset);',
    'el("rect", { "class": "inset-mark", x: 20, y: 18, width: 50, height: 44, fill: "#4c9a52" }, inset);',
  ].join('\n'),
});

// ── img ─────────────────────────────────────────────────────────────────────

const IMG_BLOCKS = { width: 240, height: 150, background: [236, 236, 230], regions: [
  { name: 'red-block', px: [20, 18, 70, 52], rgb: [200, 60, 50] },
  { name: 'blue-block', px: [130, 26, 84, 92], rgb: [50, 90, 200] },
  { name: 'green-block', px: [28, 92, 64, 44], rgb: [60, 160, 80] },
] };
const IMG_PORTRAIT = { width: 120, height: 180, background: [245, 240, 228], regions: [
  { name: 'top-band', px: [12, 14, 96, 36], rgb: [214, 140, 40] },
  { name: 'middle-square', px: [34, 70, 52, 52], rgb: [110, 60, 170] },
  { name: 'foot-strip', px: [18, 140, 84, 26], rgb: [40, 130, 140] },
] };
function imgPane(spec, cls, alt) {
  const uri = dataUri(paintPng(spec.width, spec.height, spec.background, spec.regions));
  return pane({ cls, caption: alt, fig: `<img class="photo" alt="${alt}" width="${spec.width}" height="${spec.height}" src="${uri}">` });
}

// ── canvas ──────────────────────────────────────────────────────────────────

// Drawn by the pane's script; a canvas whose context is unavailable (jsdom has
// none) keeps its fallback text and its box.
const CANVAS_SHAPES = { width: 320, height: 200, shapes: [
  { name: 'left-rect', at: [24, 30, 90, 60], fill: '#c0603a' },
  { name: 'disc', at: [150, 40, 80, 80], fill: '#3a6fc0', circle: true },
  { name: 'base-bar', at: [40, 140, 240, 36], fill: '#4c9a52' },
] };
const CANVAS_GRID = { width: 240, height: 240, shapes: [
  { name: 'cell-0-0', at: [10, 10, 60, 60], fill: '#8a4cb5' },
  { name: 'cell-1-2', at: [170, 90, 60, 60], fill: '#b5523b' },
  { name: 'cell-2-1', at: [90, 170, 60, 60], fill: '#3b6fb5' },
] };
function canvasPane(spec, cls, label) {
  const draw = spec.shapes.map((s) => {
    const [x, y, w, h] = s.at;
    return s.circle
      ? `g.fillStyle = "${s.fill}"; g.beginPath(); g.arc(${x + w / 2}, ${y + h / 2}, ${w / 2}, 0, Math.PI * 2); g.fill();`
      : `g.fillStyle = "${s.fill}"; g.fillRect(${x}, ${y}, ${w}, ${h});`;
  });
  return pane({
    cls,
    caption: label,
    fig: `<canvas class="board" width="${spec.width}" height="${spec.height}" aria-label="${label}">${label}</canvas>`,
    script: [
      'var c = root.querySelector("canvas.board");',
      'var g = c.getContext ? c.getContext("2d") : null;',
      'if (g) {',
      '  g.fillStyle = "#f6f4ee"; g.fillRect(0, 0, c.width, c.height);',
      ...draw.map((d) => `  ${d}`),
      '}',
    ].join('\n'),
  });
}

// ── the set ─────────────────────────────────────────────────────────────────

const deepFreeze = (o) => {
  Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
};
const boxes = (spec, key) => spec[key].map((r) => ({ name: r.name, box: norm(r.px || r.at, spec.width, spec.height) }));

const FIXTURES = deepFreeze([
  { id: 'pt-svg-static', type: 'svg', title: 'svg · static viewBox', html: SVG_STATIC, target: 'svg.chart',
    features: [{ name: 'bar-a', shape: 'rect.bar-a' }, { name: 'bar-b', shape: 'rect.bar-b' }, { name: 'dot', shape: 'circle.dot' }] },
  { id: 'pt-svg-bars', type: 'svg', title: 'svg · built by script', html: SVG_BARS, target: 'svg.bars',
    features: [0, 1, 2, 3].map((i) => ({ name: `bar-${i}`, shape: `rect.bar-${i}` })) },
  { id: 'pt-svg-scatter', type: 'svg', title: 'svg · groups and an inset', html: SVG_SCATTER, target: 'svg.scatter',
    features: [{ name: 'pt-a', shape: 'circle.pt-a' }, { name: 'pt-b', shape: 'circle.pt-b' },
      { name: 'pt-c', shape: 'rect.pt-c' }, { name: 'inset-mark', shape: 'rect.inset-mark' }] },
  { id: 'pt-img-blocks', type: 'img', title: 'img · three blocks', html: imgPane(IMG_BLOCKS, '', 'Three coloured blocks'),
    target: 'img.photo', features: boxes(IMG_BLOCKS, 'regions'), png: { width: IMG_BLOCKS.width, height: IMG_BLOCKS.height } },
  { id: 'pt-img-portrait', type: 'img', title: 'img · portrait bands', html: imgPane(IMG_PORTRAIT, 'right', 'Three bands in a portrait'),
    target: 'img.photo', features: boxes(IMG_PORTRAIT, 'regions'), png: { width: IMG_PORTRAIT.width, height: IMG_PORTRAIT.height } },
  { id: 'pt-canvas-shapes', type: 'canvas', title: 'canvas · shapes', html: canvasPane(CANVAS_SHAPES, '', 'Shapes on a canvas'),
    target: 'canvas.board', features: boxes(CANVAS_SHAPES, 'shapes') },
  { id: 'pt-canvas-grid', type: 'canvas', title: 'canvas · grid cells', html: canvasPane(CANVAS_GRID, 'right', 'Cells on a grid'),
    target: 'canvas.board', features: boxes(CANVAS_GRID, 'shapes') },
]);

// The panes as the mounts of one node, with one comment copy anchored by a
// point (kindsOf → ['element', 'point']).
function fixtureNode({ fixtures = FIXTURES, id = 'pt-node', anchor = null } = {}) {
  if (!fixtures.length) throw new TypeError('point-fixtures: fixtureNode needs at least one fixture');
  const first = fixtures[0];
  return {
    id,
    mounts: fixtures.map((f) => ({ id: f.id, html: f.html, params: { title: f.title }, owner: 'claude' })),
    markdown: [],
    store: {},
    comments: [{
      id: 'c1',
      text: 'a point on a fixed-aspect target',
      shared: true,
      anchor: anchor || { v: 1, kind: 'point', mount: first.id, x: 0.5, y: 0.5, aspect: 1 },
    }],
  };
}

module.exports = { FIXTURES, TARGET_TYPES, SVG_NS, fixtureNode, paintPng, dataUri };

'use strict';
// The document element payload's fixture (annotation engine tranche 4, U522;
// PLAN-T4 §2.4 F7): one payload of contract v1 (lib/server/runtime/
// elements-doc-src.js validatePayload) and the node whose panes it anchors on,
// for the runtime's own test (test/elements-doc-runtime.test.js) and for every
// unit that builds or reads a payload (U521's builder asserts its output
// against validatePayload and this shape; U523–U526 splice it).
//
//   fixture() → {node, payload}   fresh copies each call
//
// The payload holds:
//   c1  a comment on fx-a's `p.lead` (a converted 0.8.5 anchor), recorded
//       exact, with a reply of Claude's: drawn as the answered pin
//   h1  a highlight over 'quick brown fox' in fx-a (a range anchor, no
//       recorded answer: the document's own resolve decides)
//   b1  'f-box', a plug-in type placed as a box ('box') on fx-b's svg, with
//       a draw module of about 1 KB (F_BOX_MODULE), one inlined asset
//       ('mark.svg') and one skipped ('big.png')
//   r1  'f-gone', a type the registry no longer lists (removed): its
//       payload null, drawn as the generic mark on fx-a's `li.two`
//   s1  a comment on the markdown item md-notes (a source anchor over
//       'three steps'), with no recorded answer: the document resolves it
//       over the payload's `sources` table, md-notes' {src, map} as
//       lib/server/preview.js pageItems(node, {sourceMap: true}) gives it
// The f-box draw reads its item through ctx.record(id) (the GET's shape) and
// writes the record's label (flat, beside id and v) to its container
// (data-f-box-label).
// No anchor here is a page anchor, no field is attribution, and the node
// carries no chat pin (L2).

const crypto = require('crypto');
const { convertAnchor } = require('../lib/core/element-log');
const { pageItems } = require('../lib/server/preview');

// The plug-in type's draw.js, as installed: its default export is `function
// draw(` (RULED U512-U522@draw-module-contract a), it draws one svg in the
// box's normalised viewBox (0 0 1 1, stretched), so a resize rescales it with
// no redraw, reads its asset through ctx.asset and its record through
// ctx.record (as a draw written to the live contract does).
const F_BOX_MODULE = [
  '// f-box: frames its target in the normalised viewBox (0 0 1 1).',
  'const NS = \'http://www.w3.org/2000/svg\';',
  'export const glyph = { dx: -13, dy: -26, w: 26, h: 26 };',
  'export const targets = \'panes\';',
  'export default function draw(group, ctx) {',
  '  const c = group.container;',
  '  if (!c) return;',
  '  const svg = c.ownerDocument.createElementNS(NS, \'svg\');',
  '  svg.setAttribute(\'viewBox\', \'0 0 1 1\');',
  '  svg.setAttribute(\'preserveAspectRatio\', \'none\');',
  '  svg.setAttribute(\'width\', \'100%\');',
  '  svg.setAttribute(\'height\', \'100%\');',
  '  const rect = c.ownerDocument.createElementNS(NS, \'rect\');',
  '  rect.setAttribute(\'x\', \'0.01\');',
  '  rect.setAttribute(\'y\', \'0.01\');',
  '  rect.setAttribute(\'width\', \'0.98\');',
  '  rect.setAttribute(\'height\', \'0.98\');',
  '  rect.setAttribute(\'fill\', \'none\');',
  '  rect.setAttribute(\'stroke\', \'currentColor\');',
  '  svg.appendChild(rect);',
  '  const mark = ctx && typeof ctx.asset === \'function\' ? ctx.asset(\'mark.svg\') : null;',
  '  if (mark) {',
  '    const img = c.ownerDocument.createElementNS(NS, \'image\');',
  '    img.setAttribute(\'href\', mark);',
  '    img.setAttribute(\'width\', \'0.1\');',
  '    img.setAttribute(\'height\', \'0.1\');',
  '    svg.appendChild(img);',
  '  }',
  '  const first = group.items[0];',
  '  const rec = first && ctx && typeof ctx.record === \'function\' ? ctx.record(first.id) : null;',
  '  if (rec && typeof rec.label === \'string\') c.setAttribute(\'data-f-box-label\', rec.label);',
  '  c.setAttribute(\'data-f-box-items\', String(group.items.length));',
  '  c.appendChild(svg);',
  '}',
  '',
].join('\n');

// A tiny inert svg, inlined as the type's one asset.
const MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#c33"/></svg>';
const MARK_URI = `data:image/svg+xml;base64,${Buffer.from(MARK_SVG).toString('base64')}`;
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// The node: two panes and, between them, one markdown item. fx-a holds the
// comment, the highlight and the removed type's targets; md-notes the source
// comment's; fx-b the svg the box type frames.
const PANE_A = '<div class="card"><p class="lead">Read the lead paragraph.</p>'
  + '<p class="body">The quick brown fox jumps over the lazy dog.</p>'
  + '<ul><li class="one">first</li><li class="two">second</li></ul></div>';
const MD_NOTES = '## Notes\n\nThe plan holds three steps.';
const PANE_B = '<figure><svg class="chart" viewBox="0 0 200 100" width="200" height="100">'
  + '<rect x="0" y="0" width="200" height="100" fill="#eee"/><text x="10" y="50">chart</text></svg></figure>';

function fixtureNode() {
  return {
    id: 'n1',
    mounts: [
      { id: 'fx-a', html: PANE_A, params: {}, pane_state: {} },
      { id: 'fx-b', html: PANE_B, params: {}, pane_state: {} },
    ],
    markdown: [{ id: 'md-notes', text: MD_NOTES }],
    order: ['fx-a', 'md-notes', 'fx-b'],
    store: {},
  };
}

// The payload's sources table for `node`: each named markdown item's {src,
// map}, exactly as pageItems(node, {sourceMap: true}) gives them.
function sourcesOf(node, ids) {
  const out = {};
  for (const it of pageItems(node, { sourceMap: true })) if (it.md != null && ids.includes(it.md)) out[it.md] = { src: it.src, map: it.map };
  return out;
}

function fixturePayload() {
  return {
    v: 1,
    builtins: ['comment', 'highlight'],
    types: [{
      type: 'f-box',
      schema: 'f-box@1',
      reads: ['f-box@1'],
      place: 'box',
      module: F_BOX_MODULE,
      sha256: sha256(F_BOX_MODULE),
      assets: { 'mark.svg': MARK_URI },
      skipped: [{ rel: 'big.png', reason: 'over the cap' }],
    }],
    items: [
      {
        id: 'b1', v: 1, type: 'f-box', schema: 'f-box@1', seq: 3,
        anchor: convertAnchor({ mount: 'fx-b', selector: 'svg.chart', text: 'chart', ordinal: 0 }),
        shared: true, answer: { state: 'exact' }, payload: { label: 'framed' },
      },
      {
        id: 'c1', v: 2, type: 'comment', schema: 'comment@2', seq: 1,
        anchor: convertAnchor({ mount: 'fx-a', selector: 'p.lead', text: 'Read the lead paragraph.', ordinal: 0 }),
        shared: true, answer: { state: 'exact' },
        payload: { text: 'Is this the right lead?', replies: [{ text: 'Yes, kept it.', claude: true }] },
      },
      {
        id: 'h1', v: 1, type: 'highlight', schema: 'highlight@1', seq: 2,
        anchor: { v: 1, kind: 'range', mount: 'fx-a', quote: { exact: 'quick brown fox', prefix: 'The ', suffix: ' jumps' } },
        shared: true, answer: null, payload: { color: 'gold', note: 'the subject' },
      },
      {
        id: 'r1', v: 1, type: 'f-gone', schema: 'f-gone@1', seq: 4,
        anchor: convertAnchor({ mount: 'fx-a', selector: 'li.two', text: 'second', ordinal: 0 }),
        shared: true, answer: { state: 'exact' }, payload: null,
      },
      {
        id: 's1', v: 1, type: 'comment', schema: 'comment@2', seq: 5,
        anchor: { v: 1, kind: 'source', md: 'md-notes', slug: 'notes', quote: { exact: 'three steps', prefix: 'The plan holds ', suffix: '.' } },
        shared: true, answer: null, payload: { text: 'Only three?', replies: [] },
      },
    ],
    removed: ['f-gone'],
    sources: sourcesOf(fixtureNode(), ['md-notes']),
  };
}

function fixture() {
  return { node: fixtureNode(), payload: fixturePayload() };
}

module.exports = { fixture, fixtureNode, fixturePayload, sourcesOf, F_BOX_MODULE, MARK_URI };

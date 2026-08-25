// Static guards over the shell's chrome: the layout must survive the product's
// CANONICAL posture (a terminal beside a browser — roughly half a screen), and
// every icon-only control must carry an accessible name.
//
// The layout half is not a shape-match on the stylesheet: it resolves which
// `grid-template-columns` actually wins at a given viewport width and does the
// arithmetic, so re-introducing fixed side columns that starve the graph canvas
// fails the build with a number. Before this, #overlay's fixed 288px/1fr/322px
// left the canvas ~90px wide at 700px — the product's defining feature, unusable
// in the product's own default layout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');

// Walk the stylesheet in source order and collect every declaration of `prop` on
// a rule whose selector list contains `selector`, tagged with the max-width of
// the @media block it sits in (Infinity at top level). Cascade for a single
// property with equal specificity is "last matching declaration wins", which is
// what winningValue() below applies.
function declarations(selector, prop) {
  const out = [];
  // strip comments so a commented-out rule can't be mistaken for a live one
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const mediaRe = /@media\s*\(max-width:\s*(\d+)px\s*\)\s*\{/g;
  // top-level rules = the stylesheet with every @media block removed
  const blocks = [{ max: Infinity, text: stripMedia(css) }];
  let m;
  while ((m = mediaRe.exec(css))) {
    const body = braceBody(css, mediaRe.lastIndex - 1);
    if (body != null) blocks.push({ max: Number(m[1]), text: body });
  }
  for (const b of blocks) {
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = ruleRe.exec(b.text))) {
      const sels = r[1].split(',').map((s) => s.trim());
      if (!sels.includes(selector)) continue;
      const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`).exec(r[2]);
      if (d) out.push({ max: b.max, value: d[1].trim() });
    }
  }
  return out;
}
// The substring between the brace at `openIdx` and its match.
function braceBody(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(openIdx + 1, i);
  }
  return null;
}
function stripMedia(css) {
  let out = '', i = 0;
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    out += css.slice(i, m.index);
    const body = braceBody(css, re.lastIndex - 1);
    i = re.lastIndex + (body == null ? 0 : body.length + 1);
    re.lastIndex = i;
  }
  return out + css.slice(i);
}
// Which declaration wins at viewport width W: the last one in source order whose
// media condition matches. (Every block here is a plain max-width, same file,
// same specificity — so source order is the whole cascade.)
function winningValue(selector, prop, width) {
  const matching = declarations(selector, prop).filter((d) => width <= d.max);
  return matching.length ? matching[matching.length - 1].value : null;
}
// px consumed by the fixed tracks of a grid-template-columns value.
const fixedPx = (v) => (v.match(/(\d+(?:\.\d+)?)px/g) || []).reduce((a, s) => a + parseFloat(s), 0);

test('the graph canvas stays usable at the widths this product is actually used at', () => {
  // ~700px is a terminal beside a browser on a laptop; 1000 and 1280 are wider setups.
  for (const width of [700, 760, 860, 1000, 1280]) {
    const cols = winningValue('#overlay.overlay', 'grid-template-columns', width);
    assert.ok(cols, `#overlay.overlay declares grid-template-columns at ${width}px`);
    const canvas = width - fixedPx(cols);
    assert.ok(canvas >= 380,
      `at ${width}px the graph canvas gets ${canvas}px (cols: ${cols}) — it must keep at least 380px`);
  }
});

test('panes stop tiling once a column would be a sliver', () => {
  // #main is a 12-column grid; at half-screen widths a span-4 pane is ~160px.
  const cols = winningValue('#main', 'grid-template-columns', 700);
  assert.match(cols, /repeat\(12/, '#main keeps its 12-column grid (the resize mechanics depend on it)');
  const pane = winningValue('.pane', 'grid-column', 760);
  assert.ok(pane && /1\s*\/\s*-1/.test(pane),
    `at 760px a pane must span the full row, got: ${pane}`);
  assert.match(pane, /!important/,
    'pane spans are set inline by the drag/resize mechanics, so the override has to win');
  // ...and it must NOT apply on a wide screen, where tiling is the point.
  assert.equal(winningValue('.pane', 'grid-column', 1440), 'span 12',
    'wide screens keep the default 12-column span so inline spans still tile');
});

test('every icon-only control in the shell has an accessible name', () => {
  const { window } = new JSDOM(HTML);
  const doc = window.document;
  const bad = [];
  for (const el of doc.querySelectorAll('button')) {
    const text = (el.textContent || '').replace(/\s+/g, '');
    // a glyph or two is a picture, not a name — those need an explicit label
    if (text.length >= 3) continue;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) continue;
    bad.push(el.outerHTML.slice(0, 90));
  }
  assert.deepEqual(bad, [], 'icon-only buttons without aria-label');
});

test('every form field in the shell has a real label', () => {
  const { window } = new JSDOM(HTML);
  const doc = window.document;
  const labelled = new Set([...doc.querySelectorAll('label[for]')].map((l) => l.getAttribute('for')));
  const bad = [];
  for (const el of doc.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden') continue;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) continue;
    if (el.id && labelled.has(el.id)) continue;
    if (el.closest('label')) continue;
    bad.push(el.outerHTML.slice(0, 90)); // a placeholder is not a label
  }
  assert.deepEqual(bad, [], 'form fields with no label / aria-label');
});

// Static guards over the shell's chrome: the layout must survive the product's
// CANONICAL posture (a terminal beside a browser — roughly half a screen), and
// every icon-only control must carry an accessible name.
//
// The layout half is not a shape-match on the stylesheet: it resolves which
// `grid-template-columns` actually wins at a given viewport width and does the
// arithmetic, so re-introducing fixed side columns that starve the graph canvas
// fails the build with a number. Before this, #overlay's fixed 288px/1fr/322px
// left the canvas ~90px wide at 700px — the product's defining feature, unusable
// in the product's own default layout. (The graph is canvas-first now; the guard
// holds it there.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
// The chrome's stylesheet, then the page's (linked after it — the page sequence,
// its grid runs and their narrow-screen rules live in public/page.css).
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8')
  + '\n' + fs.readFileSync(path.join(REPO, 'public/page.css'), 'utf8');
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
  // The canvas-first graph has NO side columns: the canvas is the whole stage at
  // every width and the inspector floats over it. What could starve the canvas
  // again is a grid on #overlay, or an inspector wider than the screen.
  for (const width of [700, 760, 860, 1000, 1280]) {
    assert.equal(winningValue('#overlay.overlay', 'grid-template-columns', width), null,
      `#overlay.overlay declares no grid columns at ${width}px — the canvas is not a column`);
    const insp = winningValue('.gv-inspector', 'width', width);
    assert.ok(insp, `.gv-inspector declares a width at ${width}px`);
    if (/calc\(100%/.test(insp)) continue;           // full-bleed on a narrow screen
    const px = fixedPx(insp);
    assert.ok(width - px >= 380,
      `at ${width}px a ${insp} inspector leaves the canvas ${width - px}px of visible width — it must keep at least 380px`);
  }
  const wrap = winningValue('.graph-canvas-wrap', 'inset', 1280);
  assert.equal(wrap, '0', 'the canvas wrap fills the overlay');
});

test('panes stop tiling once a column would be a sliver — unless the run is a fixed grid', () => {
  // Each grid run is its own 12-column grid; at half-screen widths a span-4 pane
  // is ~160px, so a STACKED run (the default) folds to one column there, and a
  // FIXED run keeps its grid at a readable width and scrolls sideways instead.
  assert.match(winningValue('.run-grid', 'grid-template-columns', 1440), /repeat\(12/,
    'a run is a 12-column grid (the resize and drag mechanics depend on it)');
  for (const width of [700, 760, 900]) {
    assert.match(winningValue('.page-run.stacks .run-grid', 'grid-template-columns', width) || '', /^minmax\(0, 1fr\)$/,
      `a stacked run is one column at ${width}px`);
    assert.match(winningValue('.page-run.stacks .run-grid > .pane', 'grid-column', width) || '', /1\s*\/\s*-1/,
      `and each of its panes spans it at ${width}px`);
    assert.equal(winningValue('.page-run.fixed .run-grid', 'min-width', width), '720px', `a fixed run keeps 720px at ${width}px`);
    assert.equal(winningValue('.page-run.fixed', 'overflow-x', width), 'auto', `and scrolls sideways at ${width}px`);
  }
  // ...and none of it applies on a wide screen, where tiling is the point. The
  // placement is custom properties, never an inline grid-column, so the narrow
  // rules need no !important to win.
  assert.equal(winningValue('.page-run.stacks .run-grid', 'grid-template-columns', 1440), null);
  assert.equal(winningValue('.run-grid > .pane', 'grid-column', 1440), 'var(--col, auto) / span var(--span, 12)');
});

test('the three breakpoints: narrow bottom bar + queue screen, medium rail, wide contents slot', () => {
  // NARROW (<760): the bottom bar exists, the topbar's navigation moved into it,
  // and the open rail is a full-screen queue rather than a 272px side column.
  for (const width of [390, 700, 759]) {
    assert.equal(winningValue('.bottombar', 'display', width), 'flex', `the bottom bar shows at ${width}px`);
    assert.equal(winningValue('.rail', 'position', width), 'absolute', `the queue is a screen at ${width}px`);
    assert.equal(winningValue('.rail.open', 'width', width), 'auto', `the open queue fills the width at ${width}px`);
  }
  // MEDIUM and WIDE: no bottom bar; the rail is the side column again.
  for (const width of [760, 1000, 1280]) {
    assert.equal(winningValue('.bottombar', 'display', width), 'none', `no bottom bar at ${width}px`);
    assert.equal(winningValue('.rail.open', 'width', width), '272px', `the design's open rail at ${width}px`);
  }
  // The narrow queue screen covers the page, so the page's comment markers (on
  // #pin-layer, which paints above the whole body) must go with it — they
  // floated over the queue items (int3 visual QA). A wide rail is a column
  // beside the panes, where the markers follow their panes and stay.
  for (const width of [390, 759]) {
    assert.equal(winningValue('body:has(.rail.open) #pin-layer', 'display', width), 'none',
      `no comment markers over the queue screen at ${width}px`);
  }
  assert.equal(winningValue('body:has(.rail.open) #pin-layer', 'display', 1000), null,
    'the markers stay beside a side-column rail');
  // WIDE (≥1100) only: the contents column slot — and even there, only when filled.
  assert.equal(winningValue('.contents-nav', 'display', 1000), 'none', 'no contents column below 1100px');
  assert.equal(winningValue('.contents-nav', 'display', 1280), null, 'the contents column may show at 1280px');
  assert.equal(winningValue('.contents-nav:empty', 'display', 1280), 'none', 'an empty contents column is not drawn');
  const { window } = new JSDOM(HTML);
  const body = window.document.querySelector('.body');
  assert.equal(body.firstElementChild.id, 'contents-nav', 'the slot sits left of the well');
  assert.equal(window.document.getElementById('contents-nav').childElementCount, 0, 'and ships empty');
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

test('the replay bar keeps ✕ in its corner however the controls wrap', () => {
  // As the last item of a wrapping flex row, ✕ dropped onto a line of its own
  // under ▶ REPLAY once the bar ran out of width — at 1440px already (int3
  // visual QA). It is pinned to the popover's corner and the bar keeps room for it.
  assert.equal(winningValue('#rpo-close', 'position', 1440), 'absolute');
  assert.equal(winningValue('#rpo-close', 'right', 1440), '10px');
  assert.equal(winningValue('.rpo-bar', 'padding-right', 1440), '40px', 'the bar never runs under it');
  assert.equal(winningValue('.popover.replay-pop', 'position', 1440), 'fixed', '…a positioned popover it anchors to');
});

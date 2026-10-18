// lib/core/anchors.js, the range and source sections (annotation engine, PLAN.md
// 1C.2): range anchors resolved context first with position as the tie-break
// (GT-02's decided rule, tests/F1/text-quote.js reanchorV2), and the markdown
// source-range anchor over U222b's sourceMap with the bracket fallback behind
// CONFIG.source_bracket (RULED U222a@source-fallback (b)).
//
// Pinned: a fuzzy or bracket hit is re-resolved, and a duplicate decided only by
// position is re-resolved, never exact; the (md, slug) pair is only a tie-break
// hint; answers carry a DOM Range over the answered span. Panes mount in a
// jsdom shadow root through public/mount-runtime.js attachAndExtract, as
// test/anchors.test.js does; markdown blocks are drawn as lib/server/preview.js
// drawPage draws them (a div.md-block with data-md-id and the rendered HTML).
// The recall figures (GT-02, GT-03) are the 1C gate's, never asserted here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const { ANCHOR_STATES } = require('../lib/core/anchor-states');
const { renderMarkdown, sourceMap } = require('../lib/core/markdown');
const { pageItems } = require('../lib/server/preview');

const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const SKIP = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT']);
const wire = (o) => JSON.parse(JSON.stringify(o));

const WINDOWS = [];
function newWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(RUNTIME);
  WINDOWS.push(dom.window);
  return dom.window;
}
test.after(() => { for (const w of WINDOWS) w.close(); });
const W = newWindow();
const doc = W.document;

function mount(html, id = 'm') {
  const host = doc.createElement('div');
  host.dataset.mountId = id;
  doc.body.appendChild(host);
  return W.__wcMount.attachAndExtract(host, html).root;
}
// The pane text as the brief defines it, written independently of the factory:
// raw text nodes in document order, skip elements and data-wc-chrome excluded.
function paneText(root) {
  let s = '';
  const walk = (n) => {
    for (const ch of n.childNodes) {
      if (ch.nodeType === 3) s += ch.data;
      else if (ch.nodeType === 1 && !ch.hasAttribute('data-wc-chrome') && !SKIP.has(ch.tagName)) walk(ch);
    }
  };
  walk(root);
  return s;
}
// The text node holding the first occurrence of `needle` (in document order).
function textNode(root, needle) {
  const w = doc.createTreeWalker(root, 4);
  let n;
  while ((n = w.nextNode())) if (n.data.includes(needle)) return n;
  throw new Error(`no text node holds ${needle}`);
}
function rangeOf(sc, so, ec, eo) {
  const r = doc.createRange();
  r.setStart(sc, so);
  r.setEnd(ec, eo);
  return r;
}
// A range over `needle` inside one text node (the k-th node holding it).
function rangeIn(root, needle, k = 0) {
  const w = doc.createTreeWalker(root, 4);
  let n;
  let seen = 0;
  while ((n = w.nextNode())) {
    const at = n.data.indexOf(needle);
    if (at >= 0 && seen++ === k) return rangeOf(n, at, n, at + needle.length);
  }
  throw new Error(`no text node ${k} holds ${needle}`);
}
const ANSWER_KEYS = ['state', 'range', 'start', 'end', 'how', 'occ'];
function checkAnswer(ans) {
  for (const k of ANSWER_KEYS) assert.ok(k in ans, `answer key ${k}`);
  assert.ok(ANCHOR_STATES.includes(ans.state), ans.state);
  if (ans.state === 'orphaned') {
    assert.equal(ans.range, null);
    assert.equal(ans.start, null);
  }
}

// ── range: record ──────────────────────────────────────────────────────────

test('recordRange: one text node, three elements, an element-container boundary: pos slices to quote.exact', () => {
  const root = mount('<h2>Heading words</h2><p>The <b>quick brown</b> fox <i>jumps</i> over the lazy dog, again and again and again.</p><ul><li>one</li><li>two</li></ul>');
  const text = paneText(root);
  const cases = [
    ['one text node', rangeIn(root, 'lazy dog')],
    ['three elements', rangeOf(textNode(root, 'The '), 1, textNode(root, 'jumps'), 3)],
    ['element boundary', rangeOf(root.querySelector('p'), 1, root.querySelector('ul'), 1)],
    ['root boundaries', rangeOf(root, 0, root, root.childNodes.length)],
  ];
  for (const [name, r] of cases) {
    const rec = anchors.recordRange(root, r);
    assert.ok(rec, name);
    assert.deepStrictEqual(Object.keys(rec), ['v', 'kind', 'mount', 'quote', 'pos'], name);
    assert.equal(rec.v, 1);
    assert.equal(rec.kind, 'range');
    assert.equal(rec.mount, 'm');
    assert.equal(text.slice(rec.pos.start, rec.pos.end), rec.quote.exact, name);
    assert.equal(rec.quote.exact, r.toString(), `${name}: the selection's own text`);
    assert.ok(rec.quote.prefix.length <= 32 && rec.quote.suffix.length <= 32, name);
    assert.equal(rec.quote.prefix, text.slice(Math.max(0, rec.pos.start - 32), rec.pos.start), name);
    assert.equal(rec.quote.suffix, text.slice(rec.pos.end, rec.pos.end + 32), name);
  }
  // The element boundary sits before child 1 of <p> (after "The ") and before <li>two</li>.
  const rec = anchors.recordRange(root, cases[2][1]);
  assert.ok(rec.quote.exact.startsWith('quick brown'));
  assert.ok(rec.quote.exact.endsWith('again.one'));
  assert.equal(anchors.recordRange(root, rangeIn(root, 'lazy'), { mount: 'other' }).mount, 'other');
});

test('recordRange: text under a style, a script and a data-wc-chrome element is not pane text', () => {
  const root = mount('<p>alpha one</p><p>beta two</p>');
  const style = doc.createElement('style');
  style.textContent = '.x { color: red }';
  const script = doc.createElement('script');
  script.textContent = 'var hidden = 1;';
  const chrome = doc.createElement('div');
  chrome.setAttribute('data-wc-chrome', '');
  chrome.innerHTML = '<span>chrome words</span>';
  const second = root.querySelectorAll('p')[1];
  root.insertBefore(style, second);
  root.insertBefore(script, second);
  root.insertBefore(chrome, second);
  const rec = anchors.recordRange(root, rangeOf(textNode(root, 'alpha'), 6, textNode(root, 'beta'), 4));
  assert.equal(rec.quote.exact, 'onebeta');
  assert.deepStrictEqual(rec.pos, { start: 6, end: 13 });
  assert.equal(rec.quote.suffix, ' two');
  // A boundary inside the skipped text maps to the pane-text offset at that point.
  const inside = anchors.recordRange(root, rangeOf(textNode(root, 'alpha'), 0, style.firstChild, 3));
  assert.equal(inside.quote.exact, 'alpha one');
  const ans = anchors.resolveRange(root, wire(rec));
  assert.equal(ans.state, 'exact');
  assert.deepStrictEqual([ans.start, ans.end], [6, 13]);
});

test('recordRange: collapsed, outside the root, partly outside or over-long records null', () => {
  const root = mount('<p>' + 'x'.repeat(1990) + ' tail words here</p>');
  const n = textNode(root, 'tail');
  assert.equal(anchors.recordRange(root, rangeOf(n, 3, n, 3)), null, 'collapsed');
  const outside = doc.createElement('p');
  outside.textContent = 'outside text';
  doc.body.appendChild(outside);
  assert.equal(anchors.recordRange(root, rangeOf(outside.firstChild, 0, outside.firstChild, 7)), null, 'outside');
  const other = mount('<p>other pane</p>', 'o');
  const on = textNode(other, 'other');
  assert.equal(anchors.recordRange(root, rangeOf(on, 0, on, 5)), null, 'another pane');
  assert.equal(anchors.recordRange(root, rangeOf(n, 0, n, 2001)), null, 'over CONFIG.quote_max');
  const max = anchors.recordRange(root, rangeOf(n, 0, n, 2000));
  assert.equal(max.quote.exact.length, 2000, 'exactly quote_max records');
  assert.equal(anchors.recordRange(null, rangeOf(n, 0, n, 2)), null);
  assert.equal(anchors.recordRange(root, null), null);
});

test('recordRange: the JSON round trip resolves identically', () => {
  const root = mount('<p>first row text</p><p>shared words</p><p>second row text</p><p>shared words</p>');
  const rec = anchors.recordRange(root, rangeIn(root, 'shared words', 1));
  const a = anchors.resolveRange(root, rec);
  const b = anchors.resolveRange(root, wire(rec));
  assert.deepStrictEqual({ ...a, range: null }, { ...b, range: null });
  assert.equal(a.range.toString(), b.range.toString());
  assert.equal(a.state, 'exact');
  assert.equal(a.how, 'context');
});

// ── range: resolve ─────────────────────────────────────────────────────────

test('resolveRange: unchanged pane -> exact/unique; moved by an insertion above -> exact at the new offset', () => {
  const html = '<h3>Title</h3><p>Some sentence to quote from the pane.</p>';
  const root = mount(html);
  const rec = wire(anchors.recordRange(root, rangeIn(root, 'sentence to quote')));
  const same = anchors.resolveRange(root, rec);
  checkAnswer(same);
  assert.deepStrictEqual([same.state, same.how, same.occ], ['exact', 'unique', 1]);
  assert.deepStrictEqual([same.start, same.end], [rec.pos.start, rec.pos.end]);
  const moved = mount('<p>An inserted paragraph above.</p>' + html);
  const ans = anchors.resolveRange(moved, rec);
  assert.deepStrictEqual([ans.state, ans.how], ['exact', 'unique']);
  assert.equal(ans.start, rec.pos.start + 'An inserted paragraph above.'.length);
  assert.equal(ans.range.toString(), 'sentence to quote');
});

test('resolveRange: three identical occurrences with distinct contexts -> exact/context on the recorded one after the others shift', () => {
  const rows = (lead) => `<p>${lead}Alpha section says: the same phrase appears.</p><p>Beta section says: the same phrase appears.</p><p>Gamma section says: the same phrase appears.</p>`;
  const from = mount(rows(''));
  const rec = wire(anchors.recordRange(from, rangeIn(from, 'the same phrase', 1)));
  const to = mount(rows('Inserted words shift every row. '));
  const ans = anchors.resolveRange(to, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how, ans.occ], ['exact', 'context', 3]);
  assert.strictEqual(ans.range.startContainer, textNode(to, 'Beta section'));
  assert.equal(ans.range.toString(), 'the same phrase');
});

test('resolveRange: identical rows with identical contexts -> re-resolved/position, never exact', () => {
  const row = '<li>A repeated row that reads exactly the same every time.</li>';
  const root = mount(`<ul>${row.repeat(5)}</ul>`);
  const rec = wire(anchors.recordRange(root, rangeIn(root, 'reads exactly', 2)));
  const ans = anchors.resolveRange(root, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how, ans.occ], ['re-resolved', 'position', 5]);
  assert.strictEqual(ans.range.startContainer, root.querySelectorAll('li')[2].firstChild, 'the occurrence nearest the recorded start');
  // A context tie between two rows, the recorded one deleted: still position, re-resolved.
  const less = mount(`<ul>${row.repeat(4)}</ul>`);
  const b = anchors.resolveRange(less, rec);
  assert.deepStrictEqual([b.state, b.how], ['re-resolved', 'position']);
});

test('resolveRange: a one-word edit inside the quote -> re-resolved/fuzzy (dice >= 0.75); a rewritten quote -> orphaned', () => {
  const from = mount('<p>Intro.</p><p>The quick brown fox jumps over the lazy dog near the river bank.</p>');
  const rec = wire(anchors.recordRange(from, rangeIn(from, 'quick brown fox jumps over the lazy dog')));
  const to = mount('<p>Intro.</p><p>The quick brawn fox jumps over the lazy dog near the river bank.</p>');
  const ans = anchors.resolveRange(to, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how, ans.occ], ['re-resolved', 'fuzzy', 0]);
  assert.ok(ans.dice >= 0.75 && ans.dice < 1, String(ans.dice));
  assert.equal(ans.range.toString(), 'quick brawn fox jumps over the lazy dog');
  // fuzzy_tol is a cfg key: above the hit's dice, the same edit orphans.
  const strict = anchors.resolveRange(to, rec, { fuzzy_tol: 0.99 });
  assert.deepStrictEqual([strict.state, strict.how], ['orphaned', 'none']);
  const gone = mount('<p>Intro.</p><p>Something else entirely is written in this place now.</p>');
  const o = anchors.resolveRange(gone, rec);
  checkAnswer(o);
  assert.deepStrictEqual([o.state, o.how, o.range, o.start, o.end], ['orphaned', 'none', null, null, null]);
});

test('resolveRange: a malformed record answers orphaned/invalid-record', () => {
  const root = mount('<p>text</p>');
  for (const rec of [null, {}, { kind: 'range' }, { kind: 'range', quote: { exact: '' } }, { kind: 'source', quote: { exact: 'text' } }]) {
    const a = anchors.resolveRange(root, rec);
    assert.deepStrictEqual([a.state, a.how], ['orphaned', 'invalid-record']);
  }
});

// A seeded PRNG (mulberry32), so the table is the same on every run.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('resolveRange: across a 200-case seeded table no fuzzy answer is exact, and no position answer is exact', () => {
  const rnd = prng(20261017);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'row', 'item', 'shared', 'text', 'the', 'and', 'value', 'status', 'open', 'done'];
  const sentence = () => Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => pick(VOCAB)).join(' ');
  const tally = { exact: 0, 're-resolved': 0, orphaned: 0 };
  const how = {};
  for (let c = 0; c < 200; c++) {
    const rows = Array.from({ length: 3 + Math.floor(rnd() * 6) }, sentence);
    if (rnd() < 0.3) rows.push(rows[0], rows[0]);
    const from = mount(rows.map((r) => `<li>${r}</li>`).join(''));
    const items = from.querySelectorAll('li');
    const at = Math.floor(rnd() * items.length);
    const li = items[at].firstChild;
    const a = Math.floor(rnd() * (li.data.length - 2));
    const b = a + 2 + Math.floor(rnd() * (li.data.length - a - 2));
    const rec = wire(anchors.recordRange(from, rangeOf(li, a, li, b)));
    const next = rows.slice();
    const op = Math.floor(rnd() * 5);
    const k = Math.floor(rnd() * next.length);
    if (op === 0) next.splice(k, 0, sentence());
    else if (op === 1) next.splice(k, 1);
    else if (op === 2) next.splice(k, 0, next[k]);
    else {
      // One word of the recorded row changed (or one letter of it): the fuzzy branch.
      const words = next[at].split(' ');
      const w = Math.floor(rnd() * words.length);
      words[w] = op === 3 ? pick(VOCAB) : words[w].slice(0, -1) + 'x';
      next[at] = words.join(' ');
    }
    const to = mount(next.map((r) => `<li>${r}</li>`).join(''));
    const ans = anchors.resolveRange(to, rec);
    checkAnswer(ans);
    tally[ans.state]++;
    how[ans.how] = (how[ans.how] || 0) + 1;
    assert.ok(!(ans.how === 'fuzzy' && ans.state === 'exact'), `case ${c}: a fuzzy hit reported exact`);
    assert.ok(!(ans.how === 'position' && ans.state === 'exact'), `case ${c}: a position pick reported exact`);
    if (ans.state === 'exact') assert.equal(paneText(to).slice(ans.start, ans.end), rec.quote.exact, `case ${c}`);
    if (ans.state !== 'orphaned') assert.equal(ans.range.toString(), paneText(to).slice(ans.start, ans.end), `case ${c}: the Range`);
  }
  // The table reaches every branch it is meant to exercise.
  for (const h of ['unique', 'context', 'position', 'fuzzy']) assert.ok(how[h] > 0, `no ${h} answer in the table: ${JSON.stringify(how)}`);
});

// ── range: the DOM Range ───────────────────────────────────────────────────

test('resolveRange: the answered Range\'s toString() equals the answered text slice, single-node and multi-node', () => {
  const root = mount('<p>Plain <b>bold <i>nested</i></b> tail</p><ol><li>first</li><li>second</li></ol>');
  const text = paneText(root);
  for (const r of [rangeIn(root, 'Plain'), rangeOf(textNode(root, 'Plain'), 2, textNode(root, 'tail'), 3),
    rangeOf(textNode(root, 'nested'), 1, textNode(root, 'second'), 6), rangeOf(root, 0, root, 2)]) {
    const rec = anchors.recordRange(root, r);
    const ans = anchors.resolveRange(root, wire(rec));
    assert.equal(ans.state, 'exact');
    assert.equal(ans.range.toString(), text.slice(ans.start, ans.end));
    assert.equal(ans.range.toString(), r.toString());
  }
});

// ── source ─────────────────────────────────────────────────────────────────

// A markdown item drawn as drawPage draws it, with its map and LF source.
function block(text, id = 'md-1') {
  const el = doc.createElement('div');
  el.className = 'md-block';
  el.setAttribute('data-md-id', id);
  el.innerHTML = renderMarkdown(text);
  doc.body.appendChild(el);
  const src = String(text).replace(/\r\n?/g, '\n');
  return { el, src, map: sourceMap(text) };
}
function textIn(el, needle, k = 0) {
  const w = doc.createTreeWalker(el, 4);
  let n;
  let seen = 0;
  while ((n = w.nextNode())) if (n.data.includes(needle) && seen++ === k) return n;
  throw new Error(`no text node holds ${needle}`);
}
function selIn(el, needle, k = 0) {
  const n = textIn(el, needle, k);
  const at = n.data.indexOf(needle);
  return rangeOf(n, at, n, at + needle.length);
}

const DOC = '# Project notes\n\nAn opening paragraph with plain words.\n\n## Details\n\nSome **bold** text and a \\* star here.\n\n- first list item\n- second list item\n';

test('recordSource: a heading, a paragraph span and a list item span map to source offsets whose slice is the selection', () => {
  const b = block(DOC);
  for (const [needle, slug] of [['Project notes', 'project-notes'], ['plain words', 'project-notes'], ['second list', 'details']]) {
    const rec = anchors.recordSource(b.el, selIn(b.el, needle), b.map, b.src);
    assert.deepStrictEqual(Object.keys(rec), ['v', 'kind', 'md', 'slug', 'quote', 'pos'], needle);
    assert.equal(rec.kind, 'source');
    assert.equal(rec.md, 'md-1');
    assert.equal(rec.slug, slug, needle);
    assert.equal(b.src.slice(rec.pos.start, rec.pos.end), needle);
    assert.equal(rec.quote.exact, needle);
    assert.equal(rec.quote.prefix, b.src.slice(Math.max(0, rec.pos.start - 32), rec.pos.start));
    assert.equal(rec.quote.suffix, b.src.slice(rec.pos.end, rec.pos.end + 32));
  }
  // Across **bold** and the escaped \* (a subseq run): the slice is the source
  // span from the first selected character to the last, markup between included.
  const p = b.el.querySelector('p:nth-of-type(2)');
  const sel = rangeOf(textIn(b.el, 'bold'), 0, p.lastChild, p.lastChild.data.indexOf(' here'));
  assert.equal(sel.toString(), 'bold text and a * star');
  const rec = anchors.recordSource(b.el, sel, b.map, b.src, { md: 'md-x' });
  assert.equal(rec.md, 'md-x');
  assert.equal(b.src.slice(rec.pos.start, rec.pos.end), 'bold** text and a \\* star');
  assert.ok(b.map.runs.some((r) => r[3] === 'subseq' && r[0] < rec.pos.end && r[1] > rec.pos.start), 'a subseq run is in the span');
  const ans = anchors.resolveSource(b.el, b.src, b.map, wire(rec));
  assert.deepStrictEqual([ans.state, ans.how], ['exact', 'unique']);
  assert.equal(ans.range.toString(), 'bold text and a * star', 'the DOM Range through the map');
  // Inside the escape run alone: the slice holds the backslash, the selection does not.
  const star = anchors.recordSource(b.el, selIn(b.el, 'a * star'), b.map, b.src);
  assert.equal(b.src.slice(star.pos.start, star.pos.end), 'a \\* star');
});

test('recordSource: collapsed, outside the block, over-long, or an unaligned map records null', () => {
  const b = block(DOC);
  const n = textIn(b.el, 'plain');
  assert.equal(anchors.recordSource(b.el, rangeOf(n, 2, n, 2), b.map, b.src), null);
  const other = block('Another block of text.', 'md-2');
  assert.equal(anchors.recordSource(b.el, selIn(other.el, 'Another'), b.map, b.src), null);
  assert.equal(anchors.recordSource(b.el, selIn(b.el, 'plain'), other.map, other.src), null, 'another item\'s map');
  const long = block('x'.repeat(2100));
  const t = textIn(long.el, 'xx');
  assert.equal(anchors.recordSource(long.el, rangeOf(t, 0, t, 2001), long.map, long.src), null);
  assert.equal(anchors.recordSource(long.el, rangeOf(t, 0, t, 2000), long.map, long.src).quote.exact.length, 2000);
});

test('resolveSource: the source edited above the span -> exact at the shifted offset, the Range\'s text the selection', () => {
  const a = block(DOC);
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, 'first list item'), a.map, a.src));
  const insert = 'A new paragraph went in above.\n\n';
  const b = block(DOC.replace('## Details\n\n', '## Details\n\n' + insert));
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how], ['exact', 'unique']);
  assert.equal(ans.start, rec.pos.start + insert.length);
  assert.equal(ans.range.toString(), 'first list item');
  assert.strictEqual(ans.range.startContainer, b.el.querySelector('li').firstChild);
});

const LEAD = 'A long shared lead-in sentence that repeats.';
const TRAIL = 'A long shared trailing sentence that repeats.';
const twin = (h1, h2) => `## ${h1}\n\n${LEAD}\n\nsame para\n\n${TRAIL}\n\n## ${h2}\n\n${LEAD}\n\nsame para\n\n${TRAIL}\n`;

test('resolveSource: two equal paragraphs -> context decides; identical context -> the slug hint, else position', () => {
  // Distinct contexts: context alone decides, exact.
  const ctx = block('## One\n\nintro one\n\nsame para\n\n## Two\n\nintro two\n\nsame para\n');
  const r1 = wire(anchors.recordSource(ctx.el, selIn(ctx.el, 'same para', 1), ctx.map, ctx.src));
  const moved = block('Lead.\n\n## One\n\nintro one\n\nsame para\n\n## Two\n\nintro two\n\nsame para\n');
  const a1 = anchors.resolveSource(moved.el, moved.src, moved.map, r1);
  assert.deepStrictEqual([a1.state, a1.how, a1.occ], ['exact', 'context', 2]);
  assert.strictEqual(a1.range.startContainer, textIn(moved.el, 'same para', 1));
  // Identical 32-character contexts: the slug picks the hinted section's occurrence, exact.
  const t = block(twin('Alpha', 'Beta'));
  const rec = wire(anchors.recordSource(t.el, selIn(t.el, 'same para', 1), t.map, t.src));
  assert.equal(rec.slug, 'beta');
  const shifted = block('Intro line.\n\n' + twin('Alpha', 'Beta'));
  const a2 = anchors.resolveSource(shifted.el, shifted.src, shifted.map, rec);
  assert.deepStrictEqual([a2.state, a2.how], ['exact', 'slug']);
  assert.strictEqual(a2.range.startContainer, textIn(shifted.el, 'same para', 1));
  // The hinted heading renamed: no occurrence in a 'beta' section, so position decides, re-resolved.
  const renamed = block(twin('Alpha', 'Gamma'));
  const a3 = anchors.resolveSource(renamed.el, renamed.src, renamed.map, rec);
  assert.deepStrictEqual([a3.state, a3.how], ['re-resolved', 'position']);
  assert.strictEqual(a3.range.startContainer, textIn(renamed.el, 'same para', 1));
  // The slug is only a hint: a unique quote under a renamed heading is still exact.
  const keep = block('## Renamed\n\nOnly one paragraph quoted here.\n');
  const r5 = wire(anchors.recordSource(keep.el, selIn(keep.el, 'paragraph quoted'), keep.map, keep.src));
  const k2 = block('## Other title\n\nOnly one paragraph quoted here.\n');
  const a5 = anchors.resolveSource(k2.el, k2.src, k2.map, r5);
  assert.deepStrictEqual([a5.state, a5.how], ['exact', 'unique']);
});

test('resolveSource: a word changed inside the span -> re-resolved/fuzzy', () => {
  const a = block('## Notes\n\nThe quick brown fox jumps over the lazy dog by the river.\n');
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, 'quick brown fox jumps over the lazy dog'), a.map, a.src));
  const b = block('## Notes\n\nThe quick brawn fox jumps over the lazy dog by the river.\n');
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how], ['re-resolved', 'fuzzy']);
  assert.ok(ans.dice >= 0.75);
  assert.equal(ans.range.toString(), 'quick brawn fox jumps over the lazy dog');
});

test('resolveSource: words rewritten, prefix and suffix kept -> re-resolved/bracket with source_bracket, orphaned without; prefix gone -> orphaned', () => {
  const before = '## Plan\n\nWe agreed on the following point: ship the release on Friday morning. Then we celebrate together.\n';
  const a = block(before);
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, 'ship the release on Friday morning'), a.map, a.src));
  const after = '## Plan\n\nWe agreed on the following point: hold everything until QA signs off. Then we celebrate together.\n';
  const b = block(after);
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how], ['re-resolved', 'bracket']);
  assert.equal(b.src.slice(ans.start, ans.end), 'hold everything until QA signs off');
  assert.equal(ans.range.toString(), 'hold everything until QA signs off');
  assert.equal(anchors.CONFIG.source_bracket, true, 'on by default');
  const off = anchors.resolveSource(b.el, b.src, b.map, rec, { source_bracket: false });
  assert.deepStrictEqual([off.state, off.how, off.range], ['orphaned', 'none', null]);
  // The prefix gone (the lead-in rewritten as well): no bracket, orphaned.
  const c = block('## Plan\n\nA different opening now: hold everything until QA signs off. Then we celebrate together.\n');
  const gone = anchors.resolveSource(c.el, c.src, c.map, rec);
  assert.deepStrictEqual([gone.state, gone.how], ['orphaned', 'none']);
  // The suffix beyond exact.length * 2 + 64 characters: no bracket.
  const far = block('## Plan\n\nWe agreed on the following point: ' + 'pad '.repeat(40) + '. Then we celebrate together.\n');
  assert.equal(anchors.resolveSource(far.el, far.src, far.map, rec).state, 'orphaned');
  // A prefix tail found twice in the source is not unique: no bracket.
  const dup = block('We agreed on the following point: one.\n\n' + after);
  assert.equal(anchors.resolveSource(dup.el, dup.src, dup.map, rec).state, 'orphaned');
});

test('resolveSource: a map that does not align with the block (its DOM edited) -> orphaned/unaligned', () => {
  const a = block(DOC);
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, 'plain words'), a.map, a.src));
  const b = block(DOC);
  textIn(b.el, 'plain words').data += ' (edited in the DOM)';
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how], ['orphaned', 'unaligned']);
  const same = block(DOC);
  textIn(same.el, 'plain words').data = textIn(same.el, 'plain words').data.replace('plain', 'PLAIN');
  assert.equal(anchors.resolveSource(same.el, same.src, same.map, rec).how, 'unaligned', 'a same-length edit is caught too');
  const c = block(DOC);
  assert.equal(anchors.resolveSource(c.el, c.src, sourceMap('Other text.'), rec).how, 'unaligned', 'another text\'s map');
  assert.equal(anchors.resolveSource(c.el, c.src, null, rec).how, 'unaligned');
  assert.deepStrictEqual(anchors.resolveSource(c.el, c.src, c.map, { kind: 'source' }).how, 'invalid-record');
});

test('source anchors over pageItems(node, {sourceMap: true}): the document path records and resolves', () => {
  const node = { id: 'n', mounts: [{ id: 'p1', html: '<b>1</b>' }], markdown: [{ id: 'md-a', text: '# Title\r\n\r\nA CRLF paragraph to quote.' }], order: ['md-a', 'p1'] };
  const item = pageItems(node, { sourceMap: true }).find((x) => x.md);
  const el = doc.createElement('div');
  el.className = 'md-block';
  el.setAttribute('data-md-id', item.md);
  el.innerHTML = item.html;
  doc.body.appendChild(el);
  const rec = anchors.recordSource(el, selIn(el, 'paragraph to quote'), item.map, item.src);
  assert.equal(rec.md, 'md-a');
  assert.equal(rec.slug, 'title');
  assert.equal(item.src.slice(rec.pos.start, rec.pos.end), 'paragraph to quote');
  const ans = anchors.resolveSource(el, item.src, item.map, wire(rec));
  assert.deepStrictEqual([ans.state, ans.how], ['exact', 'unique']);
  assert.equal(ans.range.toString(), 'paragraph to quote');
});

// ── the browser copies answer as the required module ───────────────────────

test('browserModuleSource and documentSource answer range and source anchors as the required module does', async () => {
  const mod = await import('data:text/javascript,' + encodeURIComponent(anchors.browserModuleSource()));
  const root = mount('<p>one shared</p><p>two shared</p><p>The quick brawn fox.</p>');
  const rec = { v: 1, kind: 'range', mount: 'm', quote: { exact: 'shared', prefix: 'two ', suffix: '' }, pos: { start: 14, end: 20 } };
  const fz = { ...rec, quote: { exact: 'quick brown fox', prefix: '', suffix: '' } };
  for (const r of [rec, fz]) {
    const x = mod.resolveRange(root, r);
    const y = anchors.resolveRange(root, r);
    assert.deepStrictEqual({ ...x, range: null }, { ...y, range: null });
  }
  const b = block(DOC);
  const srec = anchors.recordSource(b.el, selIn(b.el, 'plain words'), b.map, b.src);
  assert.deepStrictEqual(mod.recordSource(b.el, selIn(b.el, 'plain words'), b.map, b.src), srec);
  const w = newWindow();
  w.eval(anchors.documentSource());
  const A = w.__wcMount.anchor;
  const host = w.document.createElement('div');
  w.document.body.appendChild(host);
  const r2 = w.__wcMount.attachAndExtract(host, '<p>alpha beta gamma</p>').root;
  const tn = r2.querySelector('p').firstChild;
  const sel = w.document.createRange();
  sel.setStart(tn, 6);
  sel.setEnd(tn, 10);
  const rr = A.recordRange(r2, sel);
  assert.equal(rr.quote.exact, 'beta');
  const ans = A.resolveRange(r2, rr);
  assert.deepStrictEqual([ans.state, ans.how, ans.range.toString()], ['exact', 'unique', 'beta']);
});

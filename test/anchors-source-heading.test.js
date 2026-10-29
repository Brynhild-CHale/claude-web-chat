// lib/core/anchors.js, the source anchor's heading rule (annotation engine,
// U403b, corrective to U403; RULED M3 (a) 2026-10-27, U2 (a) 2026-10-28): a pin
// on a heading means 'about this section', so it follows the heading's
// rewrite. When the quote rule and the bracket find nothing, a record whose
// string slug no heading of the current map carries answers the heading whose
// text starts exactly at the record's pos.start, re-resolved with how
// 'heading' — a re-resolve, never a guess, never exact. CONFIG.source_heading
// switches it. The five shapes are the F gate's x19 --md-twin cases
// (design/annotation-engine-redesign/tests/F4/x19-reveal.js MD_CASES), sources
// verbatim: a heading mid-item still re-resolves by the bracket; one that
// opens its item, closes it or is the whole item had no bracket and orphaned
// before this rule. Blocks are drawn as test/anchors-source-section.test.js
// draws them (a div.md-block with data-md-id and the rendered HTML).

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const anchors = require('../lib/core/anchors');
const { ANCHOR_STATES } = require('../lib/core/anchor-states');
const { renderMarkdown, sourceMap } = require('../lib/core/markdown');

const dom = new JSDOM('<!doctype html><body></body>');
test.after(() => dom.window.close());
const doc = dom.window.document;
const wire = (o) => JSON.parse(JSON.stringify(o));

function block(text, id = 'md-1') {
  const el = doc.createElement('div');
  el.className = 'md-block';
  el.setAttribute('data-md-id', id);
  el.innerHTML = renderMarkdown(text);
  doc.body.appendChild(el);
  const src = String(text).replace(/\r\n?/g, '\n');
  return { el, src, map: sourceMap(text) };
}
function selIn(el, needle) {
  const w = doc.createTreeWalker(el, 4);
  let n;
  while ((n = w.nextNode())) {
    const at = n.data.indexOf(needle);
    if (at < 0) continue;
    const r = doc.createRange();
    r.setStart(n, at);
    r.setEnd(n, at + needle.length);
    return r;
  }
  throw new Error(`no text node holds ${needle}`);
}
function checkAnswer(ans) {
  for (const k of ['state', 'range', 'start', 'end', 'how', 'occ']) assert.ok(k in ans, `answer key ${k}`);
  assert.ok(ANCHOR_STATES.includes(ans.state), ans.state);
  if (ans.state === 'orphaned') {
    assert.equal(ans.range, null);
    assert.equal(ans.start, null);
  }
  if (ans.how === 'heading') assert.equal(ans.state, 're-resolved', 'a heading answer is never exact');
}
// A pin recorded on the heading's words, as the page records one.
function headingRecord(text, words) {
  const a = block(text);
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, words), a.map, a.src));
  assert.equal(rec.quote.exact, words);
  assert.equal(rec.slug, a.map.headings.find((h) => a.src.slice(h.start, h.end).includes(words)).slug, 'the heading\'s own slug');
  return rec;
}

const MD_INTRO = 'Intro line for the section test.';
const MD_BODY = 'Body paragraph text follows here.';
// tests/F4/x19-reveal.js MD_CASES, verbatim, with the how this rule answers.
const MD_CASES = [
  { id: 'md-mid', before: `${MD_INTRO}\n\n## Old heading words\n\n${MD_BODY}`, after: `${MD_INTRO}\n\n## Brand new title\n\n${MD_BODY}`, old: 'Old heading words', now: 'Brand new title', how: 'bracket' },
  { id: 'md-open', before: '## Opening heading words\n\nBody under the opening heading, one line of prose.', after: '## Fresh opening title\n\nBody under the opening heading, one line of prose.', old: 'Opening heading words', now: 'Fresh opening title', how: 'heading' },
  { id: 'md-close', before: 'Lead paragraph before the closing heading, one line.\n\n## Closing heading words', after: 'Lead paragraph before the closing heading, one line.\n\n## Different closing words', old: 'Closing heading words', now: 'Different closing words', how: 'heading' },
  { id: 'md-only', before: '## Lone heading words', after: '## Another lone heading', old: 'Lone heading words', now: 'Another lone heading', how: 'heading' },
  { id: 'md-word', before: 'Intro for the one-word case, a line of prose.\n\n## Results\n\nBody for the one-word case, a line of prose.', after: 'Intro for the one-word case, a line of prose.\n\n## Findings\n\nBody for the one-word case, a line of prose.', old: 'Results', now: 'Findings', how: 'bracket' },
];
const NO_BRACKET = ['md-open', 'md-close', 'md-only'];

test('CONFIG.source_heading: on by default', () => {
  assert.strictEqual(anchors.CONFIG.source_heading, true);
});

for (const c of MD_CASES) {
  test(`${c.id}: a pin on the heading follows its rewrite -> re-resolved/${c.how} over the new heading's words`, () => {
    const rec = headingRecord(c.before, c.old);
    const b = block(c.after, c.id);
    const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
    checkAnswer(ans);
    assert.deepStrictEqual([ans.state, ans.how, ans.occ], ['re-resolved', c.how, 0]);
    assert.equal(b.src.slice(ans.start, ans.end), c.now);
    assert.equal(ans.range.toString(), c.now);
    assert.equal(ans.range.startContainer.parentNode.tagName, 'H2');
    // The unchanged item still resolves exact (the rule is a fallback only).
    const same = block(c.before, `${c.id}-same`);
    assert.equal(anchors.resolveSource(same.el, same.src, same.map, rec).state, 'exact');
  });
}

test('source_heading false: the three shapes the bracket cannot reach orphan; mid and word keep the bracket', () => {
  const off = { source_heading: false };
  for (const c of MD_CASES) {
    const rec = headingRecord(c.before, c.old);
    const b = block(c.after, c.id);
    const ans = anchors.resolveSource(b.el, b.src, b.map, rec, off);
    checkAnswer(ans);
    if (NO_BRACKET.includes(c.id)) assert.deepStrictEqual([ans.state, ans.how], ['orphaned', 'none'], c.id);
    else assert.deepStrictEqual([ans.state, ans.how], ['re-resolved', 'bracket'], c.id);
  }
});

test('a prose pin in a renamed heading\'s section stays as today: orphaned, never the heading', () => {
  const before = '## Plan\n\nWe agreed on the following point: ship the release on Friday morning.';
  const a = block(before);
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, 'ship the release'), a.map, a.src));
  assert.equal(rec.slug, 'plan');
  // The heading renamed and the prose rewritten: no quote, no bracket, no section.
  const b = block('## Roadmap\n\nA different opening now: hold everything until QA signs off.');
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how], ['orphaned', 'none']);
});

test('a removed heading orphans', () => {
  for (const id of NO_BRACKET) {
    const c = MD_CASES.find((x) => x.id === id);
    const rec = headingRecord(c.before, c.old);
    const gone = c.after.replace(/## [^\n]*\n*/, '') || 'Nothing else is left here.';
    const b = block(gone, id);
    const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
    checkAnswer(ans);
    assert.deepStrictEqual([ans.state, ans.how], ['orphaned', 'none'], id);
  }
});

test('the rule\'s bound: a heading rewritten AND text inserted before it (its start moved) orphans', () => {
  for (const id of NO_BRACKET) {
    const c = MD_CASES.find((x) => x.id === id);
    const rec = headingRecord(c.before, c.old);
    const b = block(`A new line inserted at the top.\n\n${c.after}`, id);
    const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
    checkAnswer(ans);
    assert.deepStrictEqual([ans.state, ans.how], ['orphaned', 'none'], id);
  }
});

test('a heading still carrying the record\'s slug is the section fallback\'s, not the heading rule\'s', () => {
  // The record's heading kept (its slug still names a heading of the current
  // map), the quote changed: the heading rule stands aside and the section answers.
  const rec = headingRecord('## Opening heading words\n\nBody under the opening heading, one line of prose.', 'Opening heading words');
  const b = block('## Opening heading words\n\nEverything below was rewritten.');
  const moved = { ...rec, quote: { ...rec.quote, exact: 'Words that are nowhere' } };
  const ans = anchors.resolveSource(b.el, b.src, b.map, moved);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how], ['re-resolved', 'section']);
});

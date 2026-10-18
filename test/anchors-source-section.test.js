// lib/core/anchors.js, the source anchor's section fallback (annotation engine,
// PLAN.md 1C.2; RULED GT-03@source-section-fallback (a), 2026-10-18): when the
// quote rule and the bracket both find nothing, a hinted source record answers
// the section its slug names in the CURRENT source, re-resolved with how
// 'section' (a guess the overlay draws as a guess), never exact, never a
// section the hint does not name, and never ahead of a quote or bracket hit.
// CONFIG.source_section switches it, for the 1C gate's with/without read.
//
// A section runs from its heading's start to the start of the next heading of
// ANY level (the gate's own section, tests/F2/p5-anchors.js secOf), else to the
// end of the source; slug null is the text above the first heading. Markdown
// blocks are drawn as lib/server/preview.js drawPage draws them (a div.md-block
// with data-md-id and the rendered HTML), as test/anchors-range.test.js does.
// GT-03b's recall is the 1C gate's, never asserted here.

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
  const r = doc.createRange();
  r.setStart(n, at);
  r.setEnd(n, at + needle.length);
  return r;
}
// The rendered text from the start of `first`'s first text node to the end of
// `last`'s last text node, read off the DOM independently of the factory.
function domText(first, last) {
  const w = doc.createTreeWalker(last, 4);
  let end = null;
  let n;
  while ((n = w.nextNode())) end = n;
  const r = doc.createRange();
  r.setStart(doc.createTreeWalker(first, 4).nextNode(), 0);
  r.setEnd(end, end.data.length);
  return r.toString();
}
const ANSWER_KEYS = ['state', 'range', 'start', 'end', 'how', 'occ'];
function checkAnswer(ans) {
  for (const k of ANSWER_KEYS) assert.ok(k in ans, `answer key ${k}`);
  assert.ok(ANCHOR_STATES.includes(ans.state), ans.state);
  if (ans.state === 'orphaned') {
    assert.equal(ans.range, null);
    assert.equal(ans.start, null);
  }
  if (ans.how === 'section') assert.equal(ans.state, 're-resolved', 'a section is never exact');
}
const heading = (b, slug) => b.map.headings.find((h) => h.slug === slug);
const plain = (a) => ({ state: a.state, start: a.start, end: a.end, how: a.how, occ: a.occ, dice: a.dice });

// The record: a span under '## Plan', with a 32-character context on each side.
const BEFORE = '# Notes\n\nOpening words of the page.\n\n## Plan\n\nWe agreed on the following point: ship the release on Friday morning. Then we celebrate together.\n\n## Next\n\nAfter that, the retro.\n';
const QUOTE = 'ship the release on Friday morning';
function planRecord() {
  const a = block(BEFORE);
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, QUOTE), a.map, a.src));
  assert.equal(rec.slug, 'plan');
  return rec;
}
// The quote and its prefix rewritten (no quote, no bracket), '## Plan' kept.
const REWRITTEN = '# Notes\n\nOpening words of the page.\n\n## Plan\n\nA different opening now: hold everything until QA signs off. Then we celebrate together.\n\n## Next\n\nAfter that, the retro.\n';

test('CONFIG.source_section: on by default, after source_bracket', () => {
  assert.strictEqual(anchors.CONFIG.source_section, true);
  const keys = Object.keys(anchors.CONFIG);
  assert.equal(keys[keys.length - 1], 'source_section');
  assert.equal(keys[keys.length - 2], 'source_bracket');
});

test('the quote and its prefix rewritten under a surviving ## Plan -> re-resolved/section over that section, never exact', () => {
  const rec = planRecord();
  const b = block(REWRITTEN);
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how, ans.occ], ['re-resolved', 'section', 0]);
  assert.equal(ans.start, heading(b, 'plan').start);
  assert.equal(ans.end, heading(b, 'next').start);
  assert.ok(b.src.slice(ans.start, ans.end).startsWith('## Plan\n'));
  const h2 = b.el.querySelectorAll('h2');
  assert.equal(ans.range.toString(), domText(h2[0], h2[0].nextElementSibling), 'the section\'s rendered text');
  assert.ok(ans.range.toString().includes('hold everything until QA signs off'));
  assert.ok(!ans.range.toString().includes('retro'));
  // The section as the last item of the source: it ends at src.length.
  const tail = block('## Intro\n\nLead.\n\n## Plan\n\nA different opening now: hold everything until QA signs off. Then we celebrate together.\n');
  const t = anchors.resolveSource(tail.el, tail.src, tail.map, rec);
  assert.deepStrictEqual([t.state, t.how, t.start, t.end], ['re-resolved', 'section', heading(tail, 'plan').start, tail.src.length]);
});

test('the section ends at the next heading of ANY level: a ### inside the ## ends it', () => {
  const rec = planRecord();
  const b = block('## Plan\n\nA different opening now: hold everything until QA signs off.\n\n### Detail\n\nMore under the sub-heading.\n\n## Next\n\nLater.\n');
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how], ['re-resolved', 'section']);
  assert.equal(ans.start, heading(b, 'plan').start);
  assert.equal(ans.end, heading(b, 'detail').start);
  assert.ok(!ans.range.toString().includes('More under'));
});

test('a slug-null record (above the first heading) -> [0, the first heading\'s start); no heading at all -> the whole source', () => {
  const a = block('The opening paragraph carries a quoted phrase in it here.\n\n## Plan\n\nBody.\n');
  const rec = wire(anchors.recordSource(a.el, selIn(a.el, 'quoted phrase'), a.map, a.src));
  assert.strictEqual(rec.slug, null);
  const b = block('Entirely rewritten lead words now sit up here.\n\n## Plan\n\nBody.\n');
  const ans = anchors.resolveSource(b.el, b.src, b.map, rec);
  checkAnswer(ans);
  assert.deepStrictEqual([ans.state, ans.how, ans.start, ans.end], ['re-resolved', 'section', 0, heading(b, 'plan').start]);
  assert.equal(ans.range.toString(), 'Entirely rewritten lead words now sit up here.');
  // No heading at all: the whole source.
  const c = block('Something else was written in its place, no heading.\n');
  const all = anchors.resolveSource(c.el, c.src, c.map, rec);
  checkAnswer(all);
  assert.deepStrictEqual([all.state, all.how, all.start, all.end], ['re-resolved', 'section', 0, c.src.length]);
  // A heading at the very top leaves the slug-null section empty: orphaned.
  const d = block('## Plan\n\nSomething else entirely was written.\n');
  assert.deepStrictEqual([anchors.resolveSource(d.el, d.src, d.map, rec).state, anchors.resolveSource(d.el, d.src, d.map, rec).how], ['orphaned', 'none']);
});

test('no guess beyond the hint: the hinted heading renamed or removed -> orphaned/none; an unhinted record -> orphaned as before', () => {
  const rec = planRecord();
  const renamed = block(REWRITTEN.replace('## Plan', '## Roadmap'));
  const r = anchors.resolveSource(renamed.el, renamed.src, renamed.map, rec);
  checkAnswer(r);
  assert.deepStrictEqual([r.state, r.how], ['orphaned', 'none']);
  const removed = block(REWRITTEN.replace('## Plan\n\n', ''));
  const m = anchors.resolveSource(removed.el, removed.src, removed.map, rec);
  assert.deepStrictEqual([m.state, m.how], ['orphaned', 'none']);
  // A slug that names a heading under a different slug is no hint for it.
  const other = block('## Plan B\n\nA different opening now: hold everything.\n');
  assert.equal(anchors.resolveSource(other.el, other.src, other.map, rec).state, 'orphaned');
  // No slug field: unhinted, so no section.
  const bare = { ...rec };
  delete bare.slug;
  const b = block(REWRITTEN);
  const u = anchors.resolveSource(b.el, b.src, b.map, bare);
  checkAnswer(u);
  assert.deepStrictEqual([u.state, u.how], ['orphaned', 'none']);
});

test('order and switches: a quote or bracket hit answers as without the section; source_section false -> orphaned; source_bracket false falls through to the section', () => {
  const off = { source_section: false };
  const hits = [];
  // unique
  const u = block('## Notes\n\nOnly one paragraph quoted here.\n');
  const ru = wire(anchors.recordSource(u.el, selIn(u.el, 'paragraph quoted'), u.map, u.src));
  hits.push(['unique', block('## Notes\n\nIntro.\n\nOnly one paragraph quoted here.\n'), ru]);
  // context
  const cx = block('## One\n\nintro one\n\nsame para\n\n## Two\n\nintro two\n\nsame para\n');
  const rc = wire(anchors.recordSource(cx.el, selIn(cx.el, 'same para', 1), cx.map, cx.src));
  hits.push(['context', block('Lead.\n\n## One\n\nintro one\n\nsame para\n\n## Two\n\nintro two\n\nsame para\n'), rc]);
  // slug and position (identical contexts)
  const LEAD = 'A long shared lead-in sentence that repeats.';
  const TRAIL = 'A long shared trailing sentence that repeats.';
  const twin = (h1, h2) => `## ${h1}\n\n${LEAD}\n\nsame para\n\n${TRAIL}\n\n## ${h2}\n\n${LEAD}\n\nsame para\n\n${TRAIL}\n`;
  const tw = block(twin('Alpha', 'Beta'));
  const rt = wire(anchors.recordSource(tw.el, selIn(tw.el, 'same para', 1), tw.map, tw.src));
  hits.push(['slug', block('Intro line.\n\n' + twin('Alpha', 'Beta')), rt]);
  hits.push(['position', block(twin('Alpha', 'Gamma')), rt]);
  // fuzzy
  const fz = block('## Notes\n\nThe quick brown fox jumps over the lazy dog by the river.\n');
  const rf = wire(anchors.recordSource(fz.el, selIn(fz.el, 'quick brown fox jumps over the lazy dog'), fz.map, fz.src));
  hits.push(['fuzzy', block('## Notes\n\nThe quick brawn fox jumps over the lazy dog by the river.\n'), rf]);
  // bracket
  const rp = planRecord();
  hits.push(['bracket', block(BEFORE.replace(QUOTE, 'hold everything until QA signs off')), rp]);
  for (const [how, b, rec] of hits) {
    const on = anchors.resolveSource(b.el, b.src, b.map, rec);
    checkAnswer(on);
    assert.equal(on.how, how, how);
    assert.deepStrictEqual(plain(on), plain(anchors.resolveSource(b.el, b.src, b.map, rec, off)), `${how}: the section never runs`);
    assert.equal(on.range.toString(), anchors.resolveSource(b.el, b.src, b.map, rec, off).range.toString(), how);
  }
  // Section off: the orphaned answer of before.
  const b = block(REWRITTEN);
  assert.deepStrictEqual(plain(anchors.resolveSource(b.el, b.src, b.map, rp, off)), plain({ state: 'orphaned', start: null, end: null, how: 'none', occ: 0 }));
  // Bracket off over a bracket-recoverable source: the section answers.
  const br = hits[hits.length - 1][1];
  const fall = anchors.resolveSource(br.el, br.src, br.map, rp, { source_bracket: false });
  checkAnswer(fall);
  assert.deepStrictEqual([fall.state, fall.how, fall.start, fall.end], ['re-resolved', 'section', heading(br, 'plan').start, heading(br, 'next').start]);
  assert.deepStrictEqual([anchors.resolveSource(br.el, br.src, br.map, rp, { source_bracket: false, source_section: false }).state], ['orphaned']);
});

test('unaligned and invalid-record answers are unchanged: no map, no section', () => {
  const rec = planRecord();
  const b = block(REWRITTEN);
  textIn(b.el, 'hold everything').data += ' (edited in the DOM)';
  assert.deepStrictEqual([anchors.resolveSource(b.el, b.src, b.map, rec).state, anchors.resolveSource(b.el, b.src, b.map, rec).how], ['orphaned', 'unaligned']);
  const c = block(REWRITTEN);
  assert.equal(anchors.resolveSource(c.el, c.src, null, rec).how, 'unaligned');
  assert.equal(anchors.resolveSource(c.el, c.src, sourceMap('Other text.'), rec).how, 'unaligned');
  const bad = anchors.resolveSource(c.el, c.src, c.map, { kind: 'source', slug: 'plan' });
  assert.deepStrictEqual([bad.state, bad.how], ['orphaned', 'invalid-record']);
});

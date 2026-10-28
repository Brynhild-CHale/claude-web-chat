// lib/core/anchors.js, the DOM-free quote entry (annotation engine, PLAN.md
// 3A.1's text half, U411; DECISIONS.md D5 split, L1): the range section's quote
// rule and quote record put on the api as they are, quoteText (quoteRule) and
// quoteOf (quoted), so the server can resolve a chat anchor against served
// text and the diff-line kind can record one, with no new matching logic.
//
// Pinned: quoteText over a pane's text answers as resolveRange answers on the
// same text (state, start, end, how, occ, dice: every field but the Range),
// across the ported F1 text-quote cases of test/anchors-range.test.js and the
// source-section fixtures of test/anchors-source-section.test.js; quoteOf
// records what recordRange records for a span and returns the head it was
// handed; both run with no DOM; both are the range section's, so a comment-only
// (element) document copy carries neither. The 36,864-byte tripwire is
// test/anchors-served.test.js's; this file only reports the compacted size.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const anchorsSrc = require('../lib/server/runtime/anchors-src');
const { renderMarkdown, sourceMap } = require('../lib/core/markdown');

const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const SKIP = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT']);
const wire = (o) => JSON.parse(JSON.stringify(o));

// The DOM-free cases run first, before any jsdom window exists in this file.
test('quoteText and quoteOf run over a plain string with no DOM present', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
  const C = anchors.CONFIG;
  const s = 'Alpha says: the same phrase appears. Beta says: the same phrase appears. A unique words here.';
  const rec = (exact, at, extra) => anchors.quoteOf({ v: 1, kind: 'item-range', ...extra }, s, at, at + exact.length);
  // unique -> exact
  const u = rec('unique words', s.indexOf('unique words'));
  assert.deepStrictEqual(anchors.quoteText(s, u, C), { state: 'exact', range: null, start: u.pos.start, end: u.pos.end, how: 'unique', occ: 1 });
  // a twin with matching context -> exact, how 'context'
  const second = s.indexOf('the same phrase', s.indexOf('Beta'));
  const tw = rec('the same phrase', second);
  const t = anchors.quoteText(s, tw, C);
  assert.deepStrictEqual([t.state, t.how, t.start, t.occ], ['exact', 'context', second, 2]);
  // a stale ordinal (it counted two occurrences, one remains) -> re-resolved
  const stale = { ...u, ordinal: { index: 1, of: 2 } };
  const st = anchors.quoteText(s, stale, C);
  assert.deepStrictEqual([st.state, st.how, st.start], ['re-resolved', 'unique', u.pos.start]);
  // a near-miss -> re-resolved, how 'fuzzy', dice >= 0.75
  const from = 'The quick brown fox jumps over the lazy dog near the river bank.';
  const fz = anchors.quoteOf({ v: 1, kind: 'item-range' }, from, 4, 43);
  assert.equal(fz.quote.exact, 'quick brown fox jumps over the lazy dog');
  const to = from.replace('brown', 'brawn');
  const f = anchors.quoteText(to, fz, C);
  assert.deepStrictEqual([f.state, f.how, f.occ], ['re-resolved', 'fuzzy', 0]);
  assert.ok(f.dice >= 0.75 && f.dice < 1, String(f.dice));
  assert.equal(to.slice(f.start, f.end), 'quick brawn fox jumps over the lazy dog');
  // nothing -> orphaned, how 'none'
  const o = anchors.quoteText('Something else entirely is written in this place now.', fz, C);
  assert.deepStrictEqual(o, { state: 'orphaned', range: null, start: null, end: null, how: 'none', occ: 0 });
  // prefer may be omitted, or given: it breaks a context tie first (how 'slug').
  const row = 'A repeated row that reads the same. ';
  const rows = row.repeat(3);
  const r = anchors.quoteOf({ v: 1, kind: 'item-range' }, rows, row.length + 2, row.length + 10);
  const p = anchors.quoteText(rows, { quote: { exact: r.quote.exact } }, C, (at) => at === 2 * row.length + 2);
  assert.deepStrictEqual([p.state, p.how, p.start], ['exact', 'slug', 2 * row.length + 2]);
});

const WINDOWS = [];
function newWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(RUNTIME);
  WINDOWS.push(dom.window);
  return dom.window;
}
test.after(() => { for (const w of WINDOWS) w.close(); });
let W = null;
const win = () => W || (W = newWindow());

function mount(html, id = 'm') {
  const host = win().document.createElement('div');
  host.dataset.mountId = id;
  win().document.body.appendChild(host);
  return win().__wcMount.attachAndExtract(host, html).root;
}
// The text the range path reads, written independently of the factory: raw
// text nodes in document order, skip elements and data-wc-chrome excluded.
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
function rangeOf(sc, so, ec, eo) {
  const r = win().document.createRange();
  r.setStart(sc, so);
  r.setEnd(ec, eo);
  return r;
}
function rangeIn(root, needle, k = 0) {
  const w = win().document.createTreeWalker(root, 4);
  let n;
  let seen = 0;
  while ((n = w.nextNode())) {
    const at = n.data.indexOf(needle);
    if (at >= 0 && seen++ === k) return rangeOf(n, at, n, at + needle.length);
  }
  throw new Error(`no text node ${k} holds ${needle}`);
}
const plain = (a) => {
  const o = { ...a };
  delete o.range;
  return o;
};

// One comparison: the string handed to quoteText must be the text the range
// path reads (root.textContent); a fixture where they differ (skipped or
// chrome nodes) is skipped and counted. Returns the answer, or null if skipped.
const tally = { compared: 0, skipped: 0 };
function compare(name, root, rec, cfg) {
  const s = root.textContent;
  if (s !== paneText(root)) {
    tally.skipped++;
    return null;
  }
  const want = anchors.resolveRange(root, rec, cfg);
  const got = anchors.quoteText(s, rec, cfg ? { ...anchors.CONFIG, ...cfg } : anchors.CONFIG);
  assert.deepStrictEqual(got, { ...plain(want), range: null }, name);
  assert.equal(got.range, null, name);
  tally.compared++;
  return got;
}

// ── the ported range cases ─────────────────────────────────────────────────

test('quoteText over the pane text answers as resolveRange: the ported F1 text-quote cases', (t) => {
  const hows = new Set();
  const note = (a) => { if (a) hows.add(a.how); };
  // unique, and moved by an insertion above
  const html = '<h3>Title</h3><p>Some sentence to quote from the pane.</p>';
  const r0 = mount(html);
  const rec0 = wire(anchors.recordRange(r0, rangeIn(r0, 'sentence to quote')));
  note(compare('unique', r0, rec0));
  note(compare('moved', mount('<p>An inserted paragraph above.</p>' + html), rec0));
  // context: three identical occurrences, the others shifted
  const rows = (lead) => `<p>${lead}Alpha section says: the same phrase appears.</p><p>Beta section says: the same phrase appears.</p><p>Gamma section says: the same phrase appears.</p>`;
  const from = mount(rows(''));
  const rec1 = wire(anchors.recordRange(from, rangeIn(from, 'the same phrase', 1)));
  note(compare('context', mount(rows('Inserted words shift every row. ')), rec1));
  // a short prefix near the pane start: ordinal within the margin; context at margin 0
  const dup = '<p>A dup' + ' xyz dup'.repeat(8) + '</p>';
  const rd = mount(dup);
  const rec2 = wire(anchors.recordRange(rd, rangeIn(rd, 'dup')));
  note(compare('short prefix', mount(dup), rec2));
  note(compare('short prefix, margin 0', mount(dup), rec2, { margin: 0 }));
  // identical rows: ordinal; the recorded one deleted: position
  const row = '<li>A repeated row that reads exactly the same every time.</li>';
  const rr = mount(`<ul>${row.repeat(5)}</ul>`);
  const rec3 = wire(anchors.recordRange(rr, rangeIn(rr, 'reads exactly', 2)));
  note(compare('ordinal', rr, rec3));
  note(compare('position', mount(`<ul>${row.repeat(4)}</ul>`), rec3));
  // fuzzy, fuzzy under a strict tolerance, and none
  const ff = mount('<p>Intro.</p><p>The quick brown fox jumps over the lazy dog near the river bank.</p>');
  const rec4 = wire(anchors.recordRange(ff, rangeIn(ff, 'quick brown fox jumps over the lazy dog')));
  const to = mount('<p>Intro.</p><p>The quick brawn fox jumps over the lazy dog near the river bank.</p>');
  const fz = compare('fuzzy', to, rec4);
  note(fz);
  assert.ok(fz.dice >= 0.75, 'dice carried');
  note(compare('fuzzy, strict', to, rec4, { fuzzy_tol: 0.99 }));
  note(compare('none', mount('<p>Intro.</p><p>Something else entirely is written in this place now.</p>'), rec4));
  // the JSON round trip, and multi-node spans
  const rt = mount('<p>first row text</p><p>shared words</p><p>second row text</p><p>shared words</p>');
  note(compare('round trip', rt, wire(anchors.recordRange(rt, rangeIn(rt, 'shared words', 1)))));
  const mn = mount('<p>Plain <b>bold <i>nested</i></b> tail</p><ol><li>first</li><li>second</li></ol>');
  note(compare('multi-node', mn, wire(anchors.recordRange(mn, rangeOf(rangeIn(mn, 'nested').startContainer, 1, rangeIn(mn, 'second').startContainer, 6)))));
  // A pane with style, script and chrome text: root.textContent is not the
  // pane text, so the case is skipped and counted.
  const sk = mount('<p>alpha one</p><p>beta two</p>');
  const style = win().document.createElement('style');
  style.textContent = '.x { color: red }';
  sk.insertBefore(style, sk.querySelectorAll('p')[1]);
  const before = tally.skipped;
  assert.equal(compare('skipped', sk, wire(anchors.recordRange(sk, rangeIn(sk, 'one')))), null);
  assert.equal(tally.skipped, before + 1, 'a fixture whose textContent differs is skipped');
  for (const h of ['unique', 'context', 'ordinal', 'position', 'fuzzy', 'none']) assert.ok(hows.has(h), `no ${h} case: ${[...hows]}`);
  t.diagnostic(`range cases: ${tally.compared} compared, ${tally.skipped} skipped (textContent is not the pane text)`);
});

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

test('quoteText answers as resolveRange across the 200-case seeded table of test/anchors-range.test.js', (t) => {
  const rnd = prng(20261017);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'row', 'item', 'shared', 'text', 'the', 'and', 'value', 'status', 'open', 'done'];
  const sentence = () => Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => pick(VOCAB)).join(' ');
  const how = {};
  let skipped = 0;
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
      const words = next[at].split(' ');
      const w = Math.floor(rnd() * words.length);
      words[w] = op === 3 ? pick(VOCAB) : words[w].slice(0, -1) + 'x';
      next[at] = words.join(' ');
    }
    const ans = compare(`case ${c}`, mount(next.map((r) => `<li>${r}</li>`).join('')), rec);
    if (!ans) { skipped++; continue; }
    how[ans.how] = (how[ans.how] || 0) + 1;
  }
  assert.equal(skipped, 0, 'list rows carry no skipped text');
  for (const h of ['unique', 'context', 'position', 'fuzzy']) assert.ok(how[h] > 0, `no ${h} answer: ${JSON.stringify(how)}`);
  t.diagnostic(`seeded table: ${JSON.stringify(how)}`);
});

// ── the source-section fixtures ────────────────────────────────────────────

function block(text, id = 'md-1') {
  const el = win().document.createElement('div');
  el.className = 'md-block';
  el.setAttribute('data-md-id', id);
  el.innerHTML = renderMarkdown(text);
  win().document.body.appendChild(el);
  const src = String(text).replace(/\r\n?/g, '\n');
  return { el, src, map: sourceMap(text) };
}
const slugAt = (map, at) => {
  let slug = null;
  for (const h of map.headings) if (h.start <= at) slug = h.slug;
  return slug;
};
const LEAD = 'A long shared lead-in sentence that repeats.';
const TRAIL = 'A long shared trailing sentence that repeats.';
const twin = (h1, h2) => `## ${h1}\n\n${LEAD}\n\nsame para\n\n${TRAIL}\n\n## ${h2}\n\n${LEAD}\n\nsame para\n\n${TRAIL}\n`;
const BEFORE = '# Notes\n\nOpening words of the page.\n\n## Plan\n\nWe agreed on the following point: ship the release on Friday morning. Then we celebrate together.\n\n## Next\n\nAfter that, the retro.\n';
// [name, the text recorded on, the needle and its occurrence, the text resolved on]
const SOURCE_CASES = [
  ['unique', '## Notes\n\nOnly one paragraph quoted here.\n', ['paragraph quoted', 0], '## Notes\n\nIntro.\n\nOnly one paragraph quoted here.\n'],
  ['context', '## One\n\nintro one\n\nsame para\n\n## Two\n\nintro two\n\nsame para\n', ['same para', 1], 'Lead.\n\n## One\n\nintro one\n\nsame para\n\n## Two\n\nintro two\n\nsame para\n'],
  ['twin', twin('Alpha', 'Beta'), ['same para', 1], 'Intro line.\n\n' + twin('Alpha', 'Beta')],
  ['twin renamed', twin('Alpha', 'Beta'), ['same para', 1], twin('Alpha', 'Gamma')],
  ['fuzzy', '## Notes\n\nThe quick brown fox jumps over the lazy dog by the river.\n', ['quick brown fox jumps over the lazy dog', 0], '## Notes\n\nThe quick brawn fox jumps over the lazy dog by the river.\n'],
  ['rewritten', BEFORE, ['ship the release on Friday morning', 0], BEFORE.replace('ship the release on Friday morning', 'hold everything until QA signs off')],
];
function selIn(el, needle, k) {
  const w = win().document.createTreeWalker(el, 4);
  let n;
  let seen = 0;
  while ((n = w.nextNode())) {
    const at = n.data.indexOf(needle);
    if (at >= 0 && seen++ === k) return rangeOf(n, at, n, at + needle.length);
  }
  throw new Error(`no text node holds ${needle}`);
}

test('quoteText answers as resolveRange over the source-section fixtures\' rendered blocks', (t) => {
  const before = { ...tally };
  for (const [name, a, [needle, k], b] of SOURCE_CASES) {
    const from = block(a);
    const rec = wire(anchors.recordRange(from.el, selIn(from.el, needle, k)));
    assert.ok(rec, name);
    compare(name, block(b).el, rec);
  }
  t.diagnostic(`source fixtures: ${tally.compared - before.compared} compared, ${tally.skipped - before.skipped} skipped`);
});

test('quoteText over the source text, with the slug as prefer, answers as resolveSource where the quote rule decides', () => {
  const want = { unique: 'unique', context: 'context', twin: 'slug', 'twin renamed': 'position', fuzzy: 'fuzzy' };
  for (const [name, a, [needle, k], b] of SOURCE_CASES) {
    if (!want[name]) continue;
    const from = block(a);
    const rec = wire(anchors.recordSource(from.el, selIn(from.el, needle, k), from.map, from.src));
    const to = block(b);
    const full = anchors.resolveSource(to.el, to.src, to.map, rec);
    assert.equal(full.how, want[name], name);
    const got = anchors.quoteText(to.src, rec, anchors.CONFIG, (at) => slugAt(to.map, at) === rec.slug);
    assert.deepStrictEqual(got, { ...plain(full), range: null }, name);
  }
});

// ── quoteOf ────────────────────────────────────────────────────────────────

test('quoteOf: the quote and pos recordRange records for the span, on the head it was handed', () => {
  const root = mount('<h2>Heading words</h2><p>The <b>quick brown</b> fox <i>jumps</i> over the lazy dog, again and again and again.</p><ul><li>one</li><li>two</li></ul>');
  const s = root.textContent;
  assert.equal(s, paneText(root));
  for (const needle of ['lazy dog', 'Heading', 'two', 'quick brown fox']) {
    const r = needle === 'quick brown fox'
      ? rangeOf(rangeIn(root, 'quick').startContainer, 0, rangeIn(root, ' fox').startContainer, 4)
      : rangeIn(root, needle);
    const rec = anchors.recordRange(root, r);
    const head = { v: 1, kind: 'item-range' };
    const out = anchors.quoteOf(head, s, rec.pos.start, rec.pos.end);
    assert.strictEqual(out, head, 'the head handed in');
    assert.deepStrictEqual(out.quote, rec.quote, needle);
    assert.deepStrictEqual(out.pos, rec.pos, needle);
    assert.deepStrictEqual(Object.keys(out), ['v', 'kind', 'quote', 'pos']);
    assert.ok(out.quote.prefix.length <= anchors.CONFIG.ctx_n && out.quote.suffix.length <= anchors.CONFIG.ctx_n);
  }
  const long = 'x'.repeat(2100);
  assert.equal(anchors.CONFIG.quote_max, 2000);
  assert.equal(anchors.quoteOf({}, long, 5, 5), null, 'an empty span');
  assert.equal(anchors.quoteOf({}, long, 6, 5), null, 'a reversed span');
  assert.equal(anchors.quoteOf({}, long, 0, 2001), null, 'over CONFIG.quote_max');
  assert.equal(anchors.quoteOf({}, long, 0, 2000).quote.exact.length, 2000, 'exactly quote_max');
  const mid = anchors.quoteOf({}, long, 100, 110);
  assert.equal(mid.quote.prefix.length, 32);
  assert.equal(mid.quote.suffix.length, 32);
});

// ── the entries in every copy ──────────────────────────────────────────────

test('the entries: the range section\'s own functions on the required module, the browser module and the range and source copies; undefined in a comment-only copy', async (t) => {
  assert.equal(typeof anchors.quoteText, 'function');
  assert.equal(typeof anchors.quoteOf, 'function');
  const mod = await import('data:text/javascript,' + encodeURIComponent(anchors.browserModuleSource()));
  assert.equal(typeof mod.quoteText, 'function');
  assert.equal(typeof mod.quoteOf, 'function');
  assert.strictEqual(mod.quoteText, mod.default.quoteText);
  const s = 'one shared two shared';
  const rec = { quote: { exact: 'shared', prefix: 'two ', suffix: '' } };
  assert.deepStrictEqual(mod.quoteText(s, rec, mod.CONFIG), anchors.quoteText(s, rec, anchors.CONFIG));
  const copies = [
    ['whole document copy', anchors.documentSource(), true],
    ['compacted whole copy', anchorsSrc.source(), true],
    ['range copy', anchors.documentSource({ kinds: ['range'] }), true],
    ['compacted range copy', anchorsSrc.source({ kinds: ['range'] }), true],
    ['source copy', anchors.documentSource({ kinds: ['source'] }), true],
    ['compacted source copy', anchorsSrc.source({ kinds: ['source'] }), true],
    ['element copy', anchors.documentSource({ kinds: ['element'] }), false],
    ['compacted element copy', anchorsSrc.source({ kinds: ['element'] }), false],
  ];
  for (const [name, src, has] of copies) {
    const w = newWindow();
    w.eval(src);
    const A = w.__wcMount.anchor;
    assert.equal(typeof A.resolve, 'function', `${name}: installed`);
    for (const n of ['quoteText', 'quoteOf']) {
      if (has) assert.equal(typeof A[n], 'function', `${name}: ${n}`);
      else assert.ok(n in A && A[n] === undefined, `${name}: ${n} is undefined`);
    }
    if (has) assert.deepStrictEqual(wire(A.quoteText(s, rec, A.CONFIG)), wire(anchors.quoteText(s, rec, anchors.CONFIG)), name);
  }
  const len = Buffer.byteLength(anchorsSrc.source());
  t.diagnostic(`anchors-src: ${len} bytes compacted (the whole factory; the tripwire is test/anchors-served.test.js's)`);
});
